/**
 * Sequential local-header scan — the salvage counterpart of the central
 * directory. When the index (EOCD + central directory) is destroyed, the local
 * headers written in front of every payload are usually still there, so entries
 * can be re-discovered by walking the file instead of trusting offsets.
 */
import { FLAG, METHOD, SIG_CENTRAL, SIG_EOCD, SIG_LOCAL, u32 } from './bytes.js';
import { parseLocalHeader } from './parse.js';

/**
 * Find the offset of the next ZIP record boundary at or after `from`.
 * Returns `u8.length` when there is none.
 */
export function findNextBoundary(u8, from) {
  for (let i = from; i + 4 <= u8.length; i++) {
    const sig = u32(u8, i);
    if (sig === SIG_LOCAL || sig === SIG_CENTRAL || sig === SIG_EOCD) return i;
  }
  return u8.length;
}

/**
 * @typedef {Object} ScannedEntry
 * @property {LocalHeader} header
 * @property {number} dataOffset
 * @property {number} dataEnd
 * @property {boolean} sizeTrusted  false when sizes come from a data descriptor
 */

/**
 * Walk the file looking for local file headers.
 * A candidate is only kept when its structure is self-consistent: sane name,
 * known-ish method, data start before EOF.
 * @param {Uint8Array} u8
 * @param {{maxEntries?:number}} [options]
 * @returns {ScannedEntry[]}
 */
export function scanLocalHeaders(u8, options = {}) {
  const maxEntries = options.maxEntries ?? 200000;
  /** @type {ScannedEntry[]} */
  const out = [];
  let i = 0;
  let guard = 0;
  while (i + 4 <= u8.length && out.length < maxEntries && guard++ < 5_000_000) {
    if (u32(u8, i) !== SIG_LOCAL) {
      i++;
      continue;
    }
    const header = parseLocalHeader(u8, i);
    if (!header) {
      i++;
      continue;
    }
    const nameLen = header.dataOffset - i - 30;
    if (nameLen <= 0 || nameLen > 4096 || header.name.length === 0) {
      i++;
      continue;
    }
    const usesDescriptor = (header.flags & FLAG.DATA_DESCRIPTOR) !== 0;
    // Without a data descriptor the local header sizes are authoritative — even a
    // compressed size of 0, which is exactly what an empty file looks like.
    // Treating 0 as "unknown" downgraded every empty entry to "partial".
    const sizeTrusted = !usesDescriptor;
    let dataEnd;
    if (sizeTrusted) {
      dataEnd = Math.min(u8.length, header.dataOffset + header.compressedSize);
    } else {
      // Unknown length: the payload ends where the next record begins.
      dataEnd = Math.min(u8.length, findNextBoundary(u8, header.dataOffset));
    }
    if (dataEnd <= header.dataOffset && header.method !== METHOD.STORED) {
      i++;
      continue;
    }
    out.push({ header, dataOffset: header.dataOffset, dataEnd, sizeTrusted });
    i = Math.max(dataEnd, header.dataOffset);
    if (usesDescriptor) {
      // Skip a data descriptor if present so we do not rescan its bytes.
      const at = dataEnd;
      if (at + 4 <= u8.length && u32(u8, at) === 0x08074b50) i = at + 16;
      else if (at + 4 <= u8.length && u32(u8, at) === SIG_LOCAL) i = at;
    }
  }
  return out;
}
