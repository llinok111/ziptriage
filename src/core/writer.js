/**
 * Minimal, deterministic ZIP writer.
 *
 * Only used to repack what the audit managed to verify, so it deliberately
 * supports the two methods the codec can round-trip (stored / deflate) and
 * writes fixed timestamps: two salvage runs over the same input must produce
 * byte-identical output.
 */
import { crc32 } from './crc32.js';
import { SIG_CENTRAL, SIG_EOCD, SIG_LOCAL, METHOD } from './bytes.js';

const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_TIME = 0;

function put16(u8, at, v) {
  u8[at] = v & 0xff;
  u8[at + 1] = (v >>> 8) & 0xff;
}
function put32(u8, at, v) {
  u8[at] = v & 0xff;
  u8[at + 1] = (v >>> 8) & 0xff;
  u8[at + 2] = (v >>> 16) & 0xff;
  u8[at + 3] = (v >>> 24) & 0xff;
}

/**
 * @param {Array<{name:string, data:Uint8Array, method?:number}>} files
 * @param {{codec:{deflateSync:Function}, level?:number}} options
 * @returns {Uint8Array}
 */
export function buildZip(files, options = {}) {
  const codec = options.codec;
  if (!codec || typeof codec.deflateSync !== 'function') {
    throw new TypeError('buildZip requires options.codec.deflateSync (fflate compatible)');
  }
  const level = options.level ?? 6;
  const encoder = new TextEncoder();
  const prepared = files.map((f) => {
    const name = encoder.encode(f.name);
    const raw = f.data;
    const crc = crc32(raw);
    let method = f.method ?? METHOD.DEFLATE;
    let body = raw;
    if (method === METHOD.DEFLATE && raw.length > 0) {
      const deflated = codec.deflateSync(raw, { level });
      if (deflated.length < raw.length) body = deflated;
      else method = METHOD.STORED;
    } else if (method === METHOD.DEFLATE) {
      method = METHOD.STORED;
    }
    return { name, crc, method, body, size: raw.length };
  });

  const localSize = prepared.reduce((n, p) => n + 30 + p.name.length + p.body.length, 0);
  const centralSize = prepared.reduce((n, p) => n + 46 + p.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);

  let at = 0;
  const offsets = [];
  for (const p of prepared) {
    offsets.push(at);
    put32(out, at, SIG_LOCAL);
    put16(out, at + 4, 20); // version needed
    put16(out, at + 6, 0x800); // UTF-8 name flag
    put16(out, at + 8, p.method);
    put16(out, at + 10, DOS_TIME);
    put16(out, at + 12, DOS_DATE);
    put32(out, at + 14, p.crc);
    put32(out, at + 18, p.body.length);
    put32(out, at + 22, p.size);
    put16(out, at + 26, p.name.length);
    put16(out, at + 28, 0);
    out.set(p.name, at + 30);
    at += 30 + p.name.length;
    out.set(p.body, at);
    at += p.body.length;
  }

  const cdStart = at;
  prepared.forEach((p, i) => {
    put32(out, at, SIG_CENTRAL);
    put16(out, at + 4, 0x031e); // made by: unix, spec 3.0
    put16(out, at + 6, 20);
    put16(out, at + 8, 0x800);
    put16(out, at + 10, p.method);
    put16(out, at + 12, DOS_TIME);
    put16(out, at + 14, DOS_DATE);
    put32(out, at + 16, p.crc);
    put32(out, at + 20, p.body.length);
    put32(out, at + 24, p.size);
    put16(out, at + 28, p.name.length);
    put16(out, at + 30, 0); // extra
    put16(out, at + 32, 0); // comment
    put16(out, at + 34, 0); // disk
    put16(out, at + 36, 0); // internal attrs
    put32(out, at + 38, 0); // external attrs
    put32(out, at + 42, offsets[i]);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  });

  put32(out, at, SIG_EOCD);
  put16(out, at + 4, 0);
  put16(out, at + 6, 0);
  put16(out, at + 8, prepared.length);
  put16(out, at + 10, prepared.length);
  put32(out, at + 12, at - cdStart);
  put32(out, at + 16, cdStart);
  put16(out, at + 20, 0);
  return out;
}
