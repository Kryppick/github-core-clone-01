// util.ts — shared HTTP / encoding / time helpers for the forge.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

/** An HTTP error carrying the status the client should see. */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  if (res.writableEnded) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...(headers ?? {}) });
  res.end(text);
}

let requestCounter = 0;

/**
 * The next deterministic request id: `req-` + a rising counter in 8 hex digits.
 * Deterministic in request order (no clock, no Math.random).
 */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** SHA-1 of `data`, as lowercase hex. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 of `data`, as raw 20 bytes. */
export function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}

/** Standard base64, one line, with padding. */
export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

const B64_LOOSE_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Base64 decode that first drops [\r\n\t ] (the contents API's tolerant decode).
 * Throws HttpError(400) on anything that is not valid base64.
 */
export function b64decodeLoose(s: string): Buffer {
  const cleaned = s.replace(/[\r\n\t ]/g, '');
  if (cleaned.length % 4 !== 0 || !B64_LOOSE_RE.test(cleaned)) {
    throw new HttpError(400, 'invalid base64');
  }
  return Buffer.from(cleaned, 'base64');
}

/** Whether `s` is a 40-char lowercase hex object id. */
export function isSha40(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

/** The all-zero object id (an unborn / deleted ref). */
export const ZERO_OID = '0'.repeat(40);

/** The trial clock in ms: MAKEFUN_TRIAL_NOW (ISO) or the scenario epoch 2025-01-01T00:00:00Z. */
export function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.parse('2025-01-01T00:00:00Z');
}

/** The trial clock as an ISO string. */
export function trialNowIso(): string {
  return new Date(trialNowMs()).toISOString();
}

/** The trial clock as whole epoch seconds. */
export function trialNowEpochSec(): number {
  return Math.floor(trialNowMs() / 1000);
}

/** A stable opaque id: base64url("kind:key") without padding. */
export function opaqueId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Read a request body whole; HttpError(413) past `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, total));
    });
    req.on('error', fail);
  });
}

/** JSON.parse with a 400 on malformed input. */
export function parseJsonBody(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'malformed JSON body');
  }
}
