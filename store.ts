// The single in-memory store every surface shares (REST, GraphQL, MCP, git).
// One process, one store: cross-surface consistency is the point of the suite.
// Determinism: timestamps come from MAKEFUN_TRIAL_NOW (via util.ts), ids are
// opaque base64url strings derived from stable keys, counters only move forward.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git-objects.ts';
import { HttpError, opaqueId, trialNowEpochSec as nowEpochSec, trialNowIso as nowIso } from './util.ts';
import { VIEWER_LOGIN } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  files: PullFile[];
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  id: string;
  databaseId: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
}

export interface ContentsFile {
  kind: 'file';
  sha: string;
  size: number;
  content: Buffer;
}

export interface ContentsDirEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
}

export interface ContentsDir {
  kind: 'dir';
  entries: ContentsDirEntry[];
}

const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Multiset line diff: additions/deletions between two file versions. */
function lineStats(oldBuf: Buffer | null, newBuf: Buffer | null): { additions: number; deletions: number } {
  const lines = (b: Buffer | null): string[] => {
    if (b === null) return [];
    const parts = b.toString('utf8').split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const oldLines = lines(oldBuf);
  const newLines = lines(newBuf);
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { additions, deletions };
}

function sameEntry(a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid;
}

export class Store {
  readonly viewerLogin: string = VIEWER_LOGIN;
  readonly token: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  readonly repos = new Map<string, Repo>();
  private repoDbSeq = 5000;
  private reqSeq = 0;

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq.toString(16).padStart(8, '0')}`;
  }

  // ---------------------------------------------------------- repositories
  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) throw new HttpError(422, 'Repository already exists');
    const repo: Repo = {
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      id: opaqueId('repo', key),
      databaseId: this.repoDbSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
    };
    this.repoDbSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    return out;
  }

  // ---------------------------------------------------------- git: refs
  /** Resolve HEAD, a full ref, a short branch/tag name, or a 40-hex object id. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    if (repo.objects.has(ref)) return ref;
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  headSha(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  // ---------------------------------------------------------- git: objects
  commitInfo(repo: Repo, oid: string): ReturnType<typeof parseCommit> | undefined {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  treeOidOfCommit(repo: Repo, commitOid: string): string | undefined {
    return this.commitInfo(repo, commitOid)?.tree;
  }

  /** Flatten a tree to path -> {oid, mode}, recursing into subdirectories. */
  flattenTree(repo: Repo, treeOid: string | null, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    if (treeOid === null) return out;
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): PullFile[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const files: PullFile[] = [];
    const names = new Set<string>([...base.keys(), ...head.keys()]);
    for (const name of [...names].sort()) {
      const b = base.get(name);
      const h = head.get(name);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      const oldBuf = b === undefined ? null : (repo.objects.get(b.oid)?.data ?? null);
      const newBuf = h === undefined ? null : (repo.objects.get(h.oid)?.data ?? null);
      const { additions, deletions } = lineStats(oldBuf, newBuf);
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      files.push({ filename: name, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }

  /** First-parent walk from a tip; newest first. */
  listCommits(repo: Repo, ref?: string): Array<{ sha: string; message: string }> {
    const tip = ref === undefined ? this.headSha(repo) : this.resolveRef(repo, ref);
    const out: Array<{ sha: string; message: string }> = [];
    let cur = tip;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const info = this.commitInfo(repo, cur);
      if (info === undefined) break;
      out.push({ sha: cur, message: info.message });
      cur = info.parents[0];
    }
    return out;
  }

  isAncestor(repo: Repo, ancestorOid: string, oid: string): boolean {
    if (ancestorOid === oid) return true;
    const stack: string[] = [oid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const info = this.commitInfo(repo, cur);
      if (info === undefined) continue;
      for (const p of info.parents) {
        if (p === ancestorOid) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** First common ancestor of two commits (BFS from both sides, deterministic). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsOfA = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const cur = stackA.pop() as string;
      if (ancestorsOfA.has(cur)) continue;
      ancestorsOfA.add(cur);
      const info = this.commitInfo(repo, cur);
      if (info !== undefined) stackA.push(...info.parents);
    }
    const stackB: string[] = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const cur = stackB.pop() as string;
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      if (ancestorsOfA.has(cur)) return cur;
      const info = this.commitInfo(repo, cur);
      if (info !== undefined) stackB.push(...info.parents);
    }
    return undefined;
  }

  private makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const epoch = nowEpochSec();
    const ident = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${epoch} +0000`;
    // Message verbatim, exactly like the suite's own buildCommit: the suite
    // never appends a trailing newline, and REST compares the message exactly
    // to what the PUT sent. Appending '\n' here would break that comparison.
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    const oid = hashObject('commit', data);
    repo.objects.set(oid, { type: 'commit', data });
    return oid;
  }

  createCommitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: string[]): string {
    const oid = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** Rebuild the tree at `pathParts` with the leaf set to blobOid (or removed when null). */
  private updateTree(repo: Repo, baseTreeOid: string | null, parts: string[], blobOid: string | null): string {
    const baseEntries: TreeEntry[] = baseTreeOid === null ? [] : (() => {
      const obj = repo.objects.get(baseTreeOid);
      return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
    })();
    const [head, ...rest] = parts as [string, ...string[]];
    const next: TreeEntry[] = [];
    let found = false;
    for (const entry of baseEntries) {
      if (entry.name !== head) {
        next.push(entry);
        continue;
      }
      found = true;
      if (rest.length === 0) {
        if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid });
        // else: drop the entry (delete)
      } else {
        const subOid = this.updateTree(repo, entry.mode === '40000' ? entry.oid : null, rest, blobOid);
        if (subOid !== EMPTY_TREE_OID) next.push({ mode: '40000', name: head, oid: subOid });
      }
    }
    if (!found) {
      if (rest.length === 0) {
        if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        const subOid = this.updateTree(repo, null, rest, blobOid);
        if (subOid !== EMPTY_TREE_OID) next.push({ mode: '40000', name: head, oid: subOid });
      }
    }
    const data = buildTree(next);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  }

  putContents(repo: Repo, branch: string, path: string, contentB64: string, message: string, sha?: string): { commitSha: string; blobSha: string; isNew: boolean } {
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]/g, ''), 'base64');
    const tip = this.branchTip(repo, branch);
    const tipTree = tip === undefined ? null : this.treeOidOfCommit(repo, tip) ?? null;
    const flat = this.flattenTree(repo, tipTree);
    const existing = flat.get(path);
    if (existing !== undefined) {
      if (sha === undefined) throw new HttpError(422, 'sha is required to update a file');
      if (sha !== existing.oid) throw new HttpError(409, 'sha does not match the current blob');
    }
    const blobSha = hashObject('blob', content);
    repo.objects.set(blobSha, { type: 'blob', data: content });
    const newTree = this.updateTree(repo, tipTree, path.split('/'), blobSha);
    const commitSha = this.createCommitOnBranch(repo, branch, message, newTree, tip === undefined ? [] : [tip]);
    return { commitSha, blobSha, isNew: existing === undefined };
  }

  deleteContents(repo: Repo, branch: string, path: string, message: string, sha: string): { commitSha: string } {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) throw new HttpError(404, 'Not Found');
    const tipTree = this.treeOidOfCommit(repo, tip) ?? null;
    const flat = this.flattenTree(repo, tipTree);
    const existing = flat.get(path);
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    if (sha !== existing.oid) throw new HttpError(409, 'sha does not match the current blob');
    const newTree = this.updateTree(repo, tipTree, path.split('/'), null);
    const commitSha = this.createCommitOnBranch(repo, branch, message, newTree, [tip]);
    return { commitSha };
  }

  getContents(repo: Repo, ref: string, path: string): ContentsFile | ContentsDir | undefined {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return undefined;
    const treeOid = this.treeOidOfCommit(repo, tip);
    if (treeOid === undefined) return undefined;
    const flat = this.flattenTree(repo, treeOid);
    const file = flat.get(path);
    if (file !== undefined) {
      const obj = repo.objects.get(file.oid);
      if (obj === undefined) return undefined;
      return { kind: 'file', sha: file.oid, size: obj.data.length, content: obj.data };
    }
    // Directory: entries directly under path (or root when path is '').
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, ContentsDirEntry>();
    for (const [p, e] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(rest, { type: 'file', name: rest, path: p, sha: e.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!entries.has(dirName)) {
          // Find the subtree oid for this directory.
          const dirTree = this.findSubtreeOid(repo, treeOid, path === '' ? dirName : `${path}/${dirName}`);
          entries.set(dirName, { type: 'dir', name: dirName, path: path === '' ? dirName : `${path}/${dirName}`, sha: dirTree ?? EMPTY_TREE_OID });
        }
      }
    }
    if (entries.size === 0) return undefined;
    return { kind: 'dir', entries: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
  }

  private findSubtreeOid(repo: Repo, treeOid: string, path: string): string | undefined {
    const parts = path.split('/');
    let cur: string | undefined = treeOid;
    for (const part of parts) {
      if (cur === undefined) return undefined;
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      cur = entry?.oid;
    }
    return cur;
  }

  createRef(repo: Repo, ref: string, sha: string): void {
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
    if (!repo.objects.has(sha)) throw new HttpError(422, 'Unknown object');
    repo.refs.set(ref, sha);
  }

  // ---------------------------------------------------------- issues
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new HttpError(422, `Unknown label: ${name}`);
    }
    repo.issueSeq += 1;
    const number = repo.issueSeq;
    const issue: Issue = {
      number,
      id: opaqueId('issue', `${repo.owner}/${repo.name}:${number}`),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: number,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === undefined) throw new HttpError(404, 'Not Found');
    repo.commentSeq += 1;
    const comment: Comment = { id: repo.commentSeq, body };
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------- pull requests
  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === undefined || baseSha === undefined) throw new HttpError(422, 'Unknown head or base branch');
    const mergeBaseSha = this.mergeBase(repo, headSha, baseSha) ?? baseSha;
    const headTree = this.treeOidOfCommit(repo, headSha) ?? null;
    const baseTree = this.treeOidOfCommit(repo, mergeBaseSha) ?? null;
    repo.pullSeq += 1;
    const number = repo.pullSeq;
    const pull: Pull = {
      number,
      id: opaqueId('pr', `${repo.owner}/${repo.name}:${number}`),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      mergeBaseSha,
      files: this.diffTrees(repo, baseTree, headTree),
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  mergePull(repo: Repo, pull: Pull): { sha: string } {
    if (pull.merged) throw new HttpError(405, 'Pull request already merged');
    if (pull.state !== 'open') throw new HttpError(405, 'Pull request is not open');
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (baseTip === undefined) throw new HttpError(404, 'Not Found');
    const baseTreeNow = this.flattenTree(repo, this.treeOidOfCommit(repo, baseTip) ?? null);
    const headTree = this.flattenTree(repo, this.treeOidOfCommit(repo, pull.headSha) ?? null);
    const mbTree = this.flattenTree(repo, this.treeOidOfCommit(repo, pull.mergeBaseSha) ?? null);
    for (const f of pull.files) {
      const inBaseNow = baseTreeNow.get(f.filename);
      const inMb = mbTree.get(f.filename);
      const inHead = headTree.get(f.filename);
      if (!sameEntry(inBaseNow, inMb) && !sameEntry(inHead, inBaseNow)) {
        throw new HttpError(405, 'Merge conflict');
      }
    }
    const headTreeOid = this.treeOidOfCommit(repo, pull.headSha);
    if (headTreeOid === undefined) throw new HttpError(404, 'Not Found');
    const sha = this.createCommitOnBranch(repo, pull.baseRef, `Merge pull request #${pull.number} from ${pull.headRef}`, headTreeOid, [baseTip]);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    return { sha };
  }
}
