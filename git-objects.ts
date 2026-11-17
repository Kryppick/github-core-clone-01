// git-objects.ts — git loose objects (SHA-1): commit / tree / blob / tag.
// No re-normalisation anywhere: parse/build round-trip byte-identically.

import { sha1Hex } from './util.ts';

/** The four object types this forge stores. */
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

/** A loose object: type + raw content WITHOUT the "<type> <size>\0" header. */
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** Pack type codes (git's numbering). */
export const OBJ_TYPE_CODE: Record<ObjType, number> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

const CODE_TO_TYPE: Record<number, ObjType> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

/** The object type for a pack type code, or undefined for delta/unknown codes. */
export function objTypeFromCode(code: number): ObjType | undefined {
  return CODE_TO_TYPE[code];
}

/** SHA-1 of "<type> <len>\0" + data. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Encode an object as its loose on-disk form: "<type> <size>\0" + data. */
export function encodeObject(type: ObjType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return Buffer.concat([header, data]);
}

/** Decode a loose object, verifying the header's type and size. */
export function decodeObject(raw: Buffer): GitObject {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('object has no header terminator');
  const header = raw.subarray(0, nul).toString('ascii');
  const space = header.indexOf(' ');
  if (space < 0) throw new Error('object header has no size');
  const type = header.slice(0, space);
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`unknown object type: ${type}`);
  }
  const size = Number(header.slice(space + 1));
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`invalid object size: ${header.slice(space + 1)}`);
  const data = raw.subarray(nul + 1);
  if (data.length !== size) throw new Error(`object size mismatch: header ${size}, got ${data.length}`);
  return { type, data: Buffer.from(data) };
}

/** A parsed commit's headers plus its raw message. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit: headers up to the blank line, then the message raw and untouched. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  let message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit's raw bytes. `message` is used verbatim (the suite's own buildCommit appends nothing). */
export function buildCommit(opts: { tree: string; parents: string[]; author: string; committer: string; message: string }): Buffer {
  let out = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) out += `parent ${parent}\n`;
  out += `author ${opts.author}\ncommitter ${opts.committer}\n\n${opts.message}`;
  return Buffer.from(out, 'utf8');
}

/** One tree entry: ascii mode, name, object id. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree: "<mode> SP <name> NUL <20-byte oid>" per entry, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('tree entry has no mode terminator');
    const mode = data.subarray(pos, space).toString('ascii');
    if (!/^[0-9]+$/.test(mode)) throw new Error(`tree entry has a non-numeric mode: ${mode}`);
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name terminator or short oid');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/**
 * Git's tree sort: compare names byte-wise, with a directory sorting as if its name ended in '/'.
 * Returns a new sorted array; the input is untouched.
 */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const keyOf = (entry: TreeEntry): Buffer => {
    const name = Buffer.from(entry.name, 'utf8');
    const mode = entry.mode.replace(/^0+/, '') || '0';
    return mode === '40000' ? Buffer.concat([name, Buffer.from('/')]) : name;
  };
  return entries.slice().sort((a, b) => Buffer.compare(keyOf(a), keyOf(b)));
}

/** Build a tree's raw bytes, git-sorted, modes ascii without leading zeros. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    const mode = entry.mode.replace(/^0+/, '') || '0';
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    const oid = Buffer.from(entry.oid, 'hex');
    if (oid.length !== 20) throw new Error(`tree entry oid is not 20 bytes: ${entry.oid}`);
    parts.push(oid);
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag: headers up to the blank line, then the message raw. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
