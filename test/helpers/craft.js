/**
 * Test fixture builder: writes ZIP bytes field by field so a test can lie about
 * any single field (CRC, sizes, names, offsets) without hand-editing hex dumps.
 * Deliberately independent of src/core/writer.js — a bug in the writer must not
 * be able to hide itself.
 */
import { deflateSync } from 'fflate';
import { crc32 } from '../../src/core/crc32.js';

const enc = new TextEncoder();

function u16(v) {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * @typedef {Object} EntrySpec
 * @property {string} name
 * @property {Uint8Array|string} [data]
 * @property {string} [cdName]         central-directory name override
 * @property {number} [method]         0 stored / 8 deflate (default deflate)
 * @property {number} [flags]
 * @property {number} [crc]            header CRC override (both LH and CD)
 * @property {number} [cdCrc]          central-directory CRC override only
 * @property {number} [csize]          header compressed size override
 * @property {number} [usize]          header uncompressed size override
 * @property {number} [cdUsize]        central-directory uncompressed size override
 * @property {number} [localName]      local header name override
 * @property {boolean} [descriptor]    append a data descriptor, set flag bit 3
 * @property {Uint8Array} [body]       override the stored body bytes
 */

/**
 * @param {EntrySpec[]} entries
 * @param {{cdCount?:number, cdOffset?:number, comment?:string, truncateTail?:number, corruptCd?:boolean, omitEocd?:boolean}} [opts]
 * @returns {Uint8Array}
 */
export function buildArchive(entries, opts = {}) {
  const chunks = [];
  let offset = 0;
  const push = (arr) => {
    chunks.push(Uint8Array.from(arr));
    offset += arr.length;
  };

  const cdRecords = [];

  for (const spec of entries) {
    const plain = typeof spec.data === 'string' ? enc.encode(spec.data) : spec.data || new Uint8Array(0);
    const method = spec.method ?? 8;
    const body = spec.body ?? (method === 8 ? deflateSync(plain, { level: 6 }) : plain);
    const crc = spec.crc ?? crc32(plain);
    const csize = spec.csize ?? body.length;
    const usize = spec.usize ?? plain.length;
    let flags = spec.flags ?? 0x800;
    if (spec.descriptor) flags |= 0x8;

    const localName = enc.encode(spec.localName ?? spec.name);
    const localOffset = offset;
    push([...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0x21)]);
    push([...u32(crc), ...u32(csize), ...u32(usize), ...u16(localName.length), ...u16(0)]);
    push([...localName]);
    push([...body]);
    if (spec.descriptor) {
      // Signature + CRC + compressed + uncompressed (32-bit form).
      push([...u32(0x08074b50), ...u32(crc), ...u32(body.length), ...u32(plain.length)]);
    }

    const cdName = enc.encode(spec.cdName ?? spec.name);
    cdRecords.push([
      ...u32(0x02014b50),
      ...u16(0x031e),
      ...u16(20),
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0x21),
      ...u32(spec.cdCrc ?? crc),
      ...u32(spec.csize ?? body.length),
      ...u32(spec.cdUsize ?? spec.usize ?? plain.length),
      ...u16(cdName.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(localOffset),
      ...cdName,
    ]);
  }

  const cdOffset = offset;
  for (const rec of cdRecords) push(rec);
  const cdSize = offset - cdOffset;

  if (opts.corruptCd) {
    // Overwrite the central directory signatures with 0xFF: the index is
    // unreadable but every local header below it is untouched.
    for (let i = cdOffset; i < offset; i++) chunks[chunks.length - 1][i - cdOffset] = 0xff;
    // The CD may be split over several chunks; patch the flat buffer at the end.
  }

  if (!opts.omitEocd) {
    const comment = opts.comment ? enc.encode(opts.comment) : new Uint8Array(0);
    push([
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(opts.cdCount ?? entries.length),
      ...u16(opts.cdCount ?? entries.length),
      ...u32(cdSize),
      ...u32(opts.cdOffset ?? cdOffset),
      ...u16(comment.length),
      ...comment,
    ]);
  }

  // Flatten (chunk-relative corruption above needs the flat view).
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  if (opts.corruptCd) out.fill(0xff, cdOffset, cdOffset + cdSize);
  if (opts.truncateTail) return out.subarray(0, Math.max(0, out.length - opts.truncateTail));
  return out;
}

/** Flip one bit at an absolute offset, returning a copy. */
export function flipBit(u8, at) {
  const copy = u8.slice();
  copy[at] ^= 0x01;
  return copy;
}

/** Absolute offset of an entry's payload, read from its local header. */
export function payloadOffset(u8, localHeaderOffset = 0) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return localHeaderOffset + 30 + dv.getUint16(localHeaderOffset + 26, true) + dv.getUint16(localHeaderOffset + 28, true);
}
