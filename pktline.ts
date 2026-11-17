// pktline.ts — git pkt-line framing and sideband writer.

/** One pkt-line: 4 lowercase hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > 65520) throw new Error(`pkt-line payload too large: ${data.length} bytes`);
  const header = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

/** A flush packet. */
export const PKT_FLUSH = Buffer.from('0000');
/** A delimiter packet. */
export const PKT_DELIM = Buffer.from('0001');
/** A response-end packet. */
export const PKT_RESPONSE_END = Buffer.from('0002');

/** One item a PktReader yields. */
export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Sequential pkt-line reader over a whole buffer. */
export class PktReader {
  readonly #buf: Buffer;
  #pos = 0;

  constructor(buf: Buffer) {
    this.#buf = buf;
  }

  /** The next item, or null at end of buffer. Throws on a malformed length prefix. */
  next(): PktItem | null {
    if (this.#pos >= this.#buf.length) return null;
    if (this.#pos + 4 > this.#buf.length) throw new Error('truncated pkt-line header');
    const header = this.#buf.subarray(this.#pos, this.#pos + 4).toString('ascii');
    if (header === '0000') {
      this.#pos += 4;
      return { kind: 'flush' };
    }
    if (header === '0001') {
      this.#pos += 4;
      return { kind: 'delim' };
    }
    if (header === '0002') {
      this.#pos += 4;
      return { kind: 'end' };
    }
    const len = Number.parseInt(header, 16);
    if (!Number.isFinite(len) || len < 4 || this.#pos + len > this.#buf.length) {
      throw new Error(`invalid pkt-line length: ${header}`);
    }
    const data = this.#buf.subarray(this.#pos + 4, this.#pos + len);
    this.#pos += len;
    return { kind: 'data', data: Buffer.from(data) };
  }

  /** The unread remainder (e.g. a raw packfile after the flush). */
  rest(): Buffer {
    return this.#buf.subarray(this.#pos);
  }
}

/** Max payload bytes of data inside one sideband packet (1 band byte + data, pkt-line cap 65520). */
export const SIDEBAND_MAX_DATA = 65515;

/**
 * Split `data` into sideband pkt-lines: each packet's payload is 1 band byte + ≤65515 data bytes.
 * Empty data yields no packets.
 */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  if (band !== 1 && band !== 2 && band !== 3) throw new Error(`invalid sideband: ${String(band)}`);
  const out: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDEBAND_MAX_DATA) {
    const chunk = data.subarray(off, Math.min(data.length, off + SIDEBAND_MAX_DATA));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}
