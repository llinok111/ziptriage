/** Little-endian byte helpers shared by the parsers. No Buffer, no Node APIs. */

export const SIG_LOCAL = 0x04034b50; // PK\x03\x04
export const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
export const SIG_EOCD = 0x06054b50; // PK\x05\x06
export const SIG_EOCD64 = 0x06064b50; // PK\x06\x06
export const SIG_EOCD64_LOC = 0x07064b50; // PK\x06\x07
export const SIG_DATA_DESC = 0x08074b50; // PK\x07\x08

export const LOCAL_MIN = 30;
export const CENTRAL_MIN = 46;
export const EOCD_MIN = 22;
export const EOCD_MAX_SEARCH = 65535 + EOCD_MIN;

export const METHOD = { STORED: 0, DEFLATE: 8 };

export const FLAG = {
  ENCRYPTED: 1 << 0,
  DATA_DESCRIPTOR: 1 << 3,
  UTF8: 1 << 11,
};

export function u16(u8, at) {
  return u8[at] | (u8[at + 1] << 8);
}
export function u32(u8, at) {
  return (u8[at] | (u8[at + 1] << 8) | (u8[at + 2] << 16) | (u8[at + 3] << 24)) >>> 0;
}
export function u64(u8, at) {
  const lo = u32(u8, at);
  const hi = u32(u8, at + 4);
  const v = hi * 0x100000000 + lo;
  if (!Number.isSafeInteger(v)) throw new RangeError('64-bit value exceeds Number.MAX_SAFE_INTEGER');
  return v;
}
export function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
/** Defensive decode: never throws on invalid UTF-8 (ZIP names are arbitrary bytes). */
export function decodeName(bytes, utf8Flag) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
}
export function hex(n, width = 8) {
  return (n >>> 0).toString(16).padStart(width, '0');
}
