// pack.ts — git packfile read/write and delta application (SHA-1, pack v2/v3).

import { deflateSync, inflateSync } from 'node:zlib';
import { sha1, sha1Hex } from './util.ts';
import { OBJ_TYPE_CODE, objTypeFromCode, type GitObject, type ObjType } from './git-objects.ts';

/** One object carried in (or read from) a packfile. */
export interface PackObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

/** Read one pack varint (type + size) at `pos`; returns type, size and next position. */
function readVarint(buf: Buffer, pos: number): { type: number; size: number; next: number } {
  if (pos >= buf.length) throw new Error('pack entry truncated at varint');
  const first = buf[pos] as number;
  const type = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let p = pos + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    if (p >= buf.length) throw new Error('pack entry truncated in varint');
    byte = buf[p] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    p += 1;
  }
  return { type, size, next: p };
}

/** Write a pack varint header for `type` and `size`. */
function writeVarint(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = ((type & 0x7) << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining !== 0) first |= 0x80;
  bytes.push(first);
  while (remaining !== 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Inflate the zlib stream starting at `pos` and find its exact end, in ONE
 * inflateSync call: with `{ info: true }` Node returns the engine beside the
 * buffer, and the engine's bytesWritten is exactly the input the stream
 * consumed — trailing bytes (the next pack entry) are not counted. The old
 * code binary-searched the end with ~log2(n) inflateSync calls per object
 * (~2.6 ms for a 3-object 1 KiB pack, ~107 us per inflateSync); this is one
 * call per object. A truncated stream still throws, as before.
 */
function inflateAt(buf: Buffer, pos: number, limit: number): { data: Buffer; next: number } {
  const out = inflateSync(buf.subarray(pos, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = out.engine.bytesWritten;
  if (!Number.isSafeInteger(consumed) || consumed <= 0 || pos + consumed > limit) {
    throw new Error('pack entry has no valid zlib stream');
  }
  return { data: out.buffer, next: pos + consumed };
}

/** Read one git delta varint at `pos`. */
function readDeltaVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error('delta truncated in varint');
    const byte = buf[p] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    p += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: p };
}

/**
 * Apply a git delta to `base`. Verifies the delta's source size against base.length
 * and the result size against the delta's target size.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  if (src.value !== base.length) {
    throw new Error(`delta source size mismatch: delta ${src.value}, base ${base.length}`);
  }
  const tgt = readDeltaVarint(delta, src.next);
  const out: Buffer[] = [];
  let produced = 0;
  let p = tgt.next;
  while (p < delta.length) {
    const op = delta[p] as number;
    p += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy offset');
        offset = delta[p] as number;
        p += 1;
      }
      if ((op & 0x02) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy offset');
        offset |= (delta[p] as number) << 8;
        p += 1;
      }
      if ((op & 0x04) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy offset');
        offset |= (delta[p] as number) << 16;
        p += 1;
      }
      if ((op & 0x08) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy offset');
        offset |= (delta[p] as number) << 24;
        p += 1;
      }
      if ((op & 0x10) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy size');
        size = delta[p] as number;
        p += 1;
      }
      if ((op & 0x20) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy size');
        size |= (delta[p] as number) << 8;
        p += 1;
      }
      if ((op & 0x40) !== 0) {
        if (p >= delta.length) throw new Error('delta truncated in copy size');
        size |= (delta[p] as number) << 16;
        p += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past base end');
      const chunk = base.subarray(offset, offset + size);
      out.push(Buffer.from(chunk));
      produced += size;
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('delta truncated in insert');
      out.push(Buffer.from(delta.subarray(p, p + op)));
      produced += op;
      p += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (produced !== tgt.value) {
    throw new Error(`delta target size mismatch: delta ${tgt.value}, produced ${produced}`);
  }
  return Buffer.concat(out, produced);
}

/**
 * Parse a packfile. Verifies the PACK magic, version 2/3, the trailer SHA-1 over all
 * preceding bytes, and that declaredCount equals the entries actually parsed. Resolves
 * OFS_DELTA against earlier entries in the same pack and REF_DELTA against `baseObjects`
 * (thin pack) or entries already parsed. Returns entries with computed oids.
 * Throws a plain Error on a corrupt pack.
 */
export function parsePack(buf: Buffer, baseObjects?: Map<string, GitObject>): PackObject[] {
  if (buf.length < 12 + 20) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version: ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = sha1(buf.subarray(0, buf.length - 20));
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');

  const limit = buf.length - 20;
  const byOffset = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();
  const out: PackObject[] = [];
  let pos = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryStart = pos;
    const header = readVarint(buf, pos);
    pos = header.next;
    let type: ObjType;
    let data: Buffer;
    if (header.type === TYPE_OFS_DELTA) {
      if (pos >= limit) throw new Error('OFS_DELTA entry truncated at offset');
      let byte = buf[pos] as number;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= limit) throw new Error('OFS_DELTA entry truncated in offset');
        byte = buf[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = entryStart - offset;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error(`OFS_DELTA base not in pack at offset ${baseOffset}`);
      const inflated = inflateAt(buf, pos, limit);
      pos = inflated.next;
      if (inflated.data.length !== header.size) {
        throw new Error(`OFS_DELTA size mismatch: header ${header.size}, got ${inflated.data.length}`);
      }
      type = base.type;
      data = applyDelta(base.data, inflated.data);
    } else if (header.type === TYPE_REF_DELTA) {
      if (pos + 20 > limit) throw new Error('REF_DELTA entry truncated at base oid');
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const inflated = inflateAt(buf, pos, limit);
      pos = inflated.next;
      if (inflated.data.length !== header.size) {
        throw new Error(`REF_DELTA size mismatch: header ${header.size}, got ${inflated.data.length}`);
      }
      const base = byOid.get(baseOid) ?? baseObjects?.get(baseOid);
      if (base === undefined) throw new Error(`REF_DELTA base not available: ${baseOid}`);
      type = base.type;
      data = applyDelta(base.data, inflated.data);
    } else {
      const resolved = objTypeFromCode(header.type);
      if (resolved === undefined) throw new Error(`unknown pack object type: ${header.type}`);
      const inflated = inflateAt(buf, pos, limit);
      pos = inflated.next;
      if (inflated.data.length !== header.size) {
        throw new Error(`pack object size mismatch: header ${header.size}, got ${inflated.data.length}`);
      }
      type = resolved;
      data = inflated.data;
    }
    const entry: PackObject = { oid: '', type, data };
    entry.oid = sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]));
    byOffset.set(entryStart, entry);
    byOid.set(entry.oid, entry);
    out.push(entry);
  }
  if (pos !== limit) throw new Error(`pack has ${limit - pos} trailing bytes after ${declaredCount} entries`);
  if (out.length !== declaredCount) throw new Error('pack entry count mismatch');
  return out;
}

/**
 * Build a packfile (PACK v2) of plain objects — no deltas. Each entry is
 * varint(type, size) + deflate(raw data); the trailer is the SHA-1 of all preceding bytes.
 */
export function buildPack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  if (objects.length > 0xffffffff) throw new Error('too many objects for one pack');
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writeVarint(OBJ_TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1(body)]);
}
