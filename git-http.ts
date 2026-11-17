// git-http.ts — git smart HTTP: upload-pack v2 (advertise, ls-refs, fetch + shallow)
// and receive-pack v0 (advertise, unpack, fast-forward check, report-status).
// Transport only: object/pack codecs live in git-objects.ts and pack.ts, pkt-line
// framing in pktline.ts, shared state in store.ts. No git binary anywhere here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTag, parseTree, type GitObject } from './git-objects.ts';
import { buildPack, parsePack, type PackObject } from './pack.ts';
import { PKT_DELIM, PKT_FLUSH, pktLine, PktReader, sideband } from './pktline.ts';
import type { Repo, Store } from './store.ts';
import { HttpError, ZERO_OID, readBody, sendJson } from './util.ts';

const AGENT = 'makefun-git/1.0';

/** Protocol v2 capabilities. Real git's capability lookup returns the FIRST
 *  line for a name, so a bare `fetch` line would shadow `fetch=shallow` and
 *  make git conclude shallow is unsupported ("Server does not support shallow
 *  requests") — hence only the `name=value` forms, exactly as git advertises
 *  them (`fetch=shallow wait-for-done`, `ls-refs=unborn`). The parsed map
 *  still carries the `fetch` and `ls-refs` keys. */
const UPLOAD_PACK_V2_CAPABILITIES: readonly string[] = [
  'fetch=shallow',
  'ls-refs=unborn',
  `agent=${AGENT}`,
  'object-format=sha1',
];

/** v0 capabilities, carried after NUL on the first advertisement line. */
const RECEIVE_PACK_CAPABILITIES =
  `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
const UPLOAD_PACK_V0_CAPABILITIES =
  `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=${AGENT}`;

/** `/<owner>/<repo>.git` plus the rest of the path, if any. */
const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git(?:\/(.*))?$/;

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** Bearer auth: the token must equal store.token; when the store has no token,
 *  any non-empty Bearer is accepted. A missing or empty Bearer is never enough. */
function hasValidAuth(req: IncomingMessage, store: Store): boolean {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (match === null) return false;
  const token = (match[1] as string).trim();
  if (token === '') return false;
  return store.token === '' ? true : token === store.token;
}

function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The default branch's tip (what Store.headSha answers). */
function headSha(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The commit an annotated tag peels to (through nested tags), or undefined when
 *  the ref does not point at a tag, the chain breaks, or it targets a non-commit. */
function peelTarget(repo: Repo, tagOid: string): string | undefined {
  const tagObj = repo.objects.get(tagOid);
  if (tagObj === undefined || tagObj.type !== 'tag') return undefined;
  let cur: string;
  try {
    cur = parseTag(tagObj.data).object;
  } catch {
    return undefined;
  }
  const seen = new Set<string>([tagOid]);
  for (;;) {
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return undefined;
    try {
      cur = parseTag(obj.data).object;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------- advertisements

function advertiseUploadPackV2(res: ServerResponse): void {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH, pktLine('version 2\n')];
  for (const cap of UPLOAD_PACK_V2_CAPABILITIES) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
}

/** v0 ref lines: HEAD first (carrying the capabilities), then refs sorted, each
 *  annotated tag followed by its peeled `^{}` line. An empty repo advertises the
 *  zero `capabilities^{}` pseudo-ref instead. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const tip = headSha(repo);
  if (tip === undefined) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  lines.push(pktLine(`${tip} HEAD\0${caps}\n`));
  for (const ref of sortedRefs(repo)) {
    const oid = repo.refs.get(ref) as string;
    lines.push(pktLine(`${oid} ${ref}\n`));
    const peeled = peelTarget(repo, oid);
    if (peeled !== undefined) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
  }
  return lines;
}

function advertiseUploadPackV0(repo: Repo, res: ServerResponse): void {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    ...v0RefLines(repo, UPLOAD_PACK_V0_CAPABILITIES),
    PKT_FLUSH,
  ];
  sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
}

function advertiseReceivePack(repo: Repo, res: ServerResponse): void {
  const parts: Buffer[] = [
    pktLine('# service=git-receive-pack\n'),
    PKT_FLUSH,
    ...v0RefLines(repo, RECEIVE_PACK_CAPABILITIES),
    PKT_FLUSH,
  ];
  sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(parts));
}

// ---------------------------------------------------------- v2 request parsing

/** A v2 request: `command=<name>` packets, a delim, then argument packets, then flush. */
interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request {
  const reader = new PktReader(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (;;) {
    const item = reader.next();
    if (item === null) break;
    if (item.kind === 'flush' || item.kind === 'end') break;
    if (item.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    const line = item.data.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= / object-format= are acknowledged and ignored.
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

// ---------------------------------------------------------- ls-refs (v2)

interface LsRefsOpts {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(args: string[]): LsRefsOpts {
  const out: LsRefsOpts = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const arg of args) {
    if (arg === 'peel') out.peel = true;
    else if (arg === 'symrefs') out.symrefs = true;
    else if (arg === 'unborn') out.unborn = true;
    else if (arg.startsWith('ref-prefix ')) out.prefixes.push(arg.slice('ref-prefix '.length));
  }
  return out;
}

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  const opts = parseLsRefsArgs(args);
  const headRef = headRefName(repo);
  const tip = headSha(repo);
  const matches = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  const symrefSuffix = opts.symrefs ? ` symref-target:${headRef}` : '';
  const lines: Buffer[] = [];
  if (tip === undefined) {
    // Unborn HEAD: real git names the line HEAD, never the branch itself —
    // a `refs/heads/<branch>` line here would read as an existing (zero-oid)
    // branch and break clients that ls-refs with a ref-prefix before their
    // first push. The HEAD line is prefix-filtered by its own name: it is
    // shown unprefixed, or when a prefix matches "HEAD" itself.
    if (opts.unborn && (opts.prefixes.length === 0 || opts.prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
      lines.push(pktLine(`unborn HEAD${symrefSuffix}\n`));
    }
  } else {
    if (opts.prefixes.length === 0 || opts.prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
      lines.push(pktLine(`${tip} HEAD${symrefSuffix}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!matches(ref)) continue;
      const oid = repo.refs.get(ref) as string;
      let line = `${oid} ${ref}`;
      if (opts.peel) {
        const peeled = peelTarget(repo, oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      lines.push(pktLine(`${line}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(lines));
}

// ---------------------------------------------------------- fetch (v2)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** `deepen-relative`: count the depth from the client's shallow boundary,
   *  not from the wants (what real git sends when deepening a shallow repo). */
  deepenRelative: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, deepenRelative: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg === 'deepen-relative') out.deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, done, filter, deepen-since, deepen-not:
    // accepted and ignored — unknown arguments never crash the fetch.
  }
  return out;
}

/** A tree and everything under it, added to `out`. */
function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    out.add(oid);
    let entries: Array<{ mode: string; name: string; oid: string }>;
    try {
      entries = parseTree(obj.data);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.add(entry.oid);
    }
  }
}

/**
 * Everything reachable from `roots`: commits with their trees, tags through to
 * their target, trees to their blobs. Walking a commit that is in `stopAt` (the
 * client's shallow boundary) includes that commit and its tree but never its
 * parents — the client holds the commit, not its history.
 */
function collectReachableTruncated(repo: Repo, roots: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      let info: { tree: string; parents: string[] };
      try {
        info = parseCommit(obj.data);
      } catch {
        continue;
      }
      collectTree(repo, info.tree, out);
      if (!stopAt.has(oid)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (obj.type === 'tag') {
      let target: string;
      try {
        target = parseTag(obj.data).object;
      } catch {
        continue;
      }
      stack.push(target);
    } else if (obj.type === 'tree') {
      collectTree(repo, oid, out);
    }
  }
  return out;
}

interface WantedWalk {
  /** Every object the walk touches (commits, their trees, tags, blobs). */
  set: Set<string>;
  /** Commits reached at exactly generation `depth` — the new shallow boundary. */
  frontier: Set<string>;
}

/**
 * Walk from `wants` in commit generations (want = generation 1, its parents = 2,
 * ...). `depth` caps the generations; without it the walk is the full closure.
 * Tag targets keep their tag's generation. Missing objects are skipped, never fatal.
 */
function collectWanted(repo: Repo, wants: readonly string[], depth: number | undefined): WantedWalk {
  const out = new Set<string>();
  const frontier = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 1 }));
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const item = queue[head] as { oid: string; gen: number };
    head += 1;
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    if (depth !== undefined && item.gen > depth) continue;
    const obj = repo.objects.get(item.oid);
    if (obj === undefined) continue;
    out.add(item.oid);
    if (obj.type === 'commit') {
      let info: { tree: string; parents: string[] };
      try {
        info = parseCommit(obj.data);
      } catch {
        continue;
      }
      collectTree(repo, info.tree, out);
      if (depth !== undefined && item.gen === depth) frontier.add(item.oid);
      for (const parent of info.parents) queue.push({ oid: parent, gen: item.gen + 1 });
    } else if (obj.type === 'tag') {
      let target: string;
      try {
        target = parseTag(obj.data).object;
      } catch {
        continue;
      }
      queue.push({ oid: target, gen: item.gen });
    } else if (obj.type === 'tree') {
      collectTree(repo, item.oid, out);
    }
  }
  return { set: out, frontier };
}

/** Pack order: commit, then its tree (subtrees before their blobs), then parents —
 *  walking through already-held commits so their wanted descendants are reached. */
function orderPackObjects(repo: Repo, wants: readonly string[], sendSet: ReadonlySet<string>): GitObject[] {
  const out: GitObject[] = [];
  const emitted = new Set<string>();
  const seen = new Set<string>();
  const emit = (oid: string): void => {
    if (!sendSet.has(oid) || emitted.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    emitted.add(oid);
    out.push(obj);
  };
  const visitTree = (treeOid: string): void => {
    if (seen.has(treeOid)) return;
    seen.add(treeOid);
    // Only trees the walk is actually sending are worth descending into: a
    // shallow fetch's send set holds one commit's tree, and recursing into
    // every ancestor's tree would parse the whole history for nothing.
    if (!sendSet.has(treeOid)) return;
    emit(treeOid);
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    let entries: Array<{ mode: string; name: string; oid: string }>;
    try {
      entries = parseTree(obj.data);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else emit(entry.oid);
    }
  };
  const visitCommit = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    // Same guard as visitTree: a parent outside the send set (a shallow
    // fetch's cutoff) must not pull its whole ancestry into the walk.
    if (!sendSet.has(oid)) return;
    emit(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    let info: { tree: string; parents: string[] };
    try {
      info = parseCommit(obj.data);
    } catch {
      return;
    }
    visitTree(info.tree);
    for (const parent of info.parents) visitCommit(parent);
  };
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      emit(want);
      let target: string;
      try {
        target = parseTag(obj.data).object;
      } catch {
        continue;
      }
      const targetObj = repo.objects.get(target);
      if (targetObj?.type === 'commit') visitCommit(target);
      else if (targetObj?.type === 'tree') visitTree(target);
      else emit(target);
    } else if (obj.type === 'commit') {
      visitCommit(want);
    } else if (obj.type === 'tree') {
      visitTree(want);
    } else {
      emit(want);
    }
  }
  // Anything in the send set the walk did not reach (defensive): still ship it.
  for (const oid of [...sendSet].sort()) emit(oid);
  return out;
}

/** The smallest BFS generation (want = generation 1) of any oid in `targets`,
 *  following parent edges (tags pass through at the same generation). */
function generationOfTargets(repo: Repo, wants: readonly string[], targets: ReadonlySet<string>): number | undefined {
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 1 }));
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const item = queue[head] as { oid: string; gen: number };
    head += 1;
    if (seen.has(item.oid)) continue;
    seen.add(item.oid);
    // BFS visits in non-decreasing generation order: the first hit is minimal.
    if (targets.has(item.oid)) return item.gen;
    const obj = repo.objects.get(item.oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      let info: { parents: string[] };
      try {
        info = parseCommit(obj.data);
      } catch {
        continue;
      }
      for (const parent of info.parents) queue.push({ oid: parent, gen: item.gen + 1 });
    } else if (obj.type === 'tag') {
      let target: string;
      try {
        target = parseTag(obj.data).object;
      } catch {
        continue;
      }
      queue.push({ oid: target, gen: item.gen });
    }
  }
  return undefined;
}

function handleFetch(repo: Repo, args: string[], res: ServerResponse): void {
  const fetchArgs = parseFetchArgs(args);
  const clientShallow = new Set(fetchArgs.shallow);
  // With `deepen-relative` the depth counts from the client's shallow boundary,
  // not from the wants: the new boundary sits N generations below the old one.
  let effectiveDepth = fetchArgs.depth;
  if (fetchArgs.depth !== undefined && fetchArgs.deepenRelative && clientShallow.size > 0) {
    const boundaryGen = generationOfTargets(repo, fetchArgs.wants, clientShallow);
    if (boundaryGen !== undefined) effectiveDepth = boundaryGen + fetchArgs.depth;
  }
  // What the client already holds: haves, truncated at its shallow boundary.
  const haveSet = collectReachableTruncated(repo, fetchArgs.haves, clientShallow);
  const wanted = collectWanted(repo, fetchArgs.wants, effectiveDepth);
  const sendSet = new Set<string>();
  for (const oid of wanted.set) if (!haveSet.has(oid)) sendSet.add(oid);
  // New shallow boundary: every commit at the depth limit, as git marks it.
  // A root commit AT the limit is listed too (a fresh depth-1 clone of a
  // one-commit repo records it in .git/shallow); a root BELOW the limit is
  // not at the frontier at all, so it is never listed (deepen to the root
  // unshallows instead of re-listing it).
  const shallow = [...wanted.frontier];
  // Unshallow: a boundary the client sent whose parent this fetch delivers.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let info: { parents: string[] };
    try {
      info = parseCommit(obj.data);
    } catch {
      continue;
    }
    if (info.parents.some((parent) => sendSet.has(parent))) unshallow.push(oid);
  }
  const knownHaves = fetchArgs.haves.filter((have) => repo.objects.has(have));

  // Sections, in order. Real git separates them with DELIM (0001) and ends the
  // response with FLUSH (0000) after the packfile — a flush between sections
  // is not what git expects. A section is only sent when it applies:
  // acknowledgments only when the client sent haves (otherwise git expects
  // the response to start at shallow-info/packfile), shallow-info when a
  // depth was asked or an old boundary was lifted.
  const sections: Buffer[][] = [];
  if (fetchArgs.haves.length > 0) {
    const ack: Buffer[] = [pktLine('acknowledgments\n')];
    if (knownHaves.length === 0) {
      ack.push(pktLine('NAK\n'));
    } else {
      for (const have of knownHaves) ack.push(pktLine(`ACK ${have}\n`));
      ack.push(pktLine('ready\n'));
    }
    sections.push(ack);
  }
  if (fetchArgs.depth !== undefined || unshallow.length > 0) {
    const info: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of shallow) info.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) info.push(pktLine(`unshallow ${oid}\n`));
    sections.push(info);
  }
  const wantedSection: Buffer[] = [pktLine('wanted-refs\n')];
  const wantSet = new Set(fetchArgs.wants);
  // Real refs only: git rejects a `HEAD` line here ("unexpected wanted-ref").
  for (const ref of sortedRefs(repo)) {
    const oid = repo.refs.get(ref) as string;
    if (wantSet.has(oid)) wantedSection.push(pktLine(`${oid} ${ref}\n`));
  }
  sections.push(wantedSection);
  const packSection: Buffer[] = [pktLine('packfile\n')];
  const pack = buildPack(orderPackObjects(repo, fetchArgs.wants, sendSet));
  for (const packet of sideband(1, pack)) packSection.push(packet);
  sections.push(packSection);
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    parts.push(...section);
    parts.push(index < sections.length - 1 ? PKT_DELIM : PKT_FLUSH);
  });
  sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------- receive-pack (v0)

interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface ParsedReceivePack {
  commands: ReceiveCommand[];
  capabilities: Set<string>;
  /** Raw packfile bytes after the command flush (empty for a delete-only push). */
  pack: Buffer;
}

function parseReceivePack(body: Buffer): ParsedReceivePack {
  const reader = new PktReader(body);
  const commands: ReceiveCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (;;) {
    const item = reader.next();
    if (item === null) break;
    if (item.kind === 'flush' || item.kind === 'end') break;
    if (item.kind === 'delim') continue;
    const text = item.data.toString('utf8').replace(/\n$/, '');
    let cmdText = text;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      cmdText = text.slice(0, nul);
      if (first) {
        for (const token of text.slice(nul + 1).split(' ')) {
          if (token !== '') capabilities.add(token);
        }
      }
    }
    first = false;
    const parts = cmdText.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command: ${cmdText.slice(0, 60)}`);
    const oldOid = parts[0] as string;
    const newOid = parts[1] as string;
    const ref = parts[2] as string;
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error('receive-pack command has a bad object id');
    }
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command has a bad ref: ${ref}`);
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities, pack: reader.rest() };
}

async function handleReceivePack(store: Store, repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const parsed = parseReceivePack(body);

  let unpackOk = true;
  let unpackDetail = 'ok';
  let stored: PackObject[] = [];
  if (parsed.pack.length > 0) {
    try {
      stored = parsePack(parsed.pack, repo.objects);
    } catch (err) {
      unpackOk = false;
      const message = err instanceof Error ? err.message : 'unpack failed';
      unpackDetail = message.replace(/[\r\n]+/g, ' ').slice(0, 120) || 'unpack failed';
    }
  }

  interface RefResult {
    ref: string;
    ok: boolean;
    reason: string;
  }
  const results: RefResult[] = [];
  if (unpackOk) {
    for (const obj of stored) {
      if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
    }
    for (const cmd of parsed.commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false;
      let reason = '';
      if (cmd.newOid === ZERO_OID) {
        // Delete: the ref must exist and the old value must match (when given).
        if (current === undefined) reason = 'non-fast-forward';
        else if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) reason = 'non-fast-forward';
        else ok = true;
      } else if (cmd.oldOid === ZERO_OID) {
        // Create: the ref must not exist and the new object must be on the server.
        if (current !== undefined) reason = 'non-fast-forward';
        else if (!repo.objects.has(cmd.newOid)) reason = 'object not found';
        else ok = true;
      } else {
        // Update: old must be the current tip and an ancestor of new.
        if (current === undefined || current !== cmd.oldOid) reason = 'non-fast-forward';
        else if (!repo.objects.has(cmd.newOid)) reason = 'object not found';
        else if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) reason = 'non-fast-forward';
        else ok = true;
      }
      if (ok) {
        if (cmd.newOid === ZERO_OID) store.deleteRef(repo, cmd.ref);
        else store.setRef(repo, cmd.ref, cmd.newOid);
      }
      results.push({ ref: cmd.ref, ok, reason });
    }
  } else {
    for (const cmd of parsed.commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report-status stream itself ends with a flush packet, inside band 1:
  // git reads the band-1 bytes as a pkt-line stream and waits for that flush —
  // without it the push hangs and dies with "remote end hung up".
  const framed = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let bodyParts: Buffer[];
  if (parsed.capabilities.has('side-band-64k')) {
    bodyParts = [...sideband(1, framed), PKT_FLUSH];
  } else {
    // The client always asks for side-band-64k; plain pkt-lines stay as fallback.
    bodyParts = [...reportLines.map((line) => pktLine(line)), PKT_FLUSH];
  }
  sendRaw(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(bodyParts));
}

// ---------------------------------------------------------- router entry

export async function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  pathname: string,
): Promise<boolean> {
  const match = GIT_PATH.exec(pathname);
  if (match === null) return false;
  const owner = match[1] as string;
  const repoName = match[2] as string;
  const rest = match[3] ?? '';
  try {
    if (!hasValidAuth(req, store)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    const method = req.method ?? 'GET';
    let service: string | null = null;
    try {
      service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service');
    } catch {
      service = null;
    }
    if (method === 'GET' && rest === 'info/refs') {
      if (repo === undefined) {
        notFound(res);
        return true;
      }
      if (service === 'git-upload-pack') {
        const protoHeader = req.headers['git-protocol'];
        const proto = Array.isArray(protoHeader) ? protoHeader.join(',') : (protoHeader ?? '');
        if (proto.includes('version=2')) advertiseUploadPackV2(res);
        else advertiseUploadPackV0(repo, res);
        return true;
      }
      if (service === 'git-receive-pack') {
        advertiseReceivePack(repo, res);
        return true;
      }
      notFound(res);
      return true;
    }
    if (method === 'POST' && rest === 'git-upload-pack') {
      if (repo === undefined) {
        notFound(res);
        return true;
      }
      const body = await readBody(req);
      const parsed = parseV2Request(body);
      if (parsed.command === 'ls-refs') {
        handleLsRefs(repo, parsed.args, res);
      } else if (parsed.command === 'fetch') {
        handleFetch(repo, parsed.args, res);
      } else {
        sendJson(res, 400, { message: `unknown git-upload-pack command: ${parsed.command}` });
      }
      return true;
    }
    if (method === 'POST' && rest === 'git-receive-pack') {
      if (repo === undefined) {
        notFound(res);
        return true;
      }
      await handleReceivePack(store, repo, req, res);
      return true;
    }
    notFound(res);
    return true;
  } catch (err) {
    // Malformed input must never take the server down: answer 400 and stay up.
    if (!res.headersSent && !res.writableEnded) {
      const status = err instanceof HttpError ? err.status : 400;
      const message = err instanceof Error ? err.message : 'bad request';
      sendJson(res, status, { message });
    }
    return true;
  }
}
