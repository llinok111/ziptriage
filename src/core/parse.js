/**
 * ZIP container structure parser.
 *
 * Reads the three records that actually matter for integrity work:
 *   1. End Of Central Directory (EOCD, optionally ZIP64)  -> where the index is
 *   2. Central Directory entries (the authoritative metadata)
 *   3. Local File Headers (redundant copy, frequently stale — and the only thing
 *      still present after a central directory is destroyed)
 *
 * The parser never trusts one source alone; it reports what each says and lets
 * the audit layer decide. No allocation is driven by header-declared sizes.
 */
import {
  SIG_CENTRAL,
  SIG_EOCD,
  SIG_EOCD64,
  SIG_EOCD64_LOC,
  SIG_LOCAL,
  CENTRAL_MIN,
  EOCD_MAX_SEARCH,
  EOCD_MIN,
  LOCAL_MIN,
  u16,
  u32,
  u64,
  decodeName,
} from './bytes.js';

/**
 * @typedef {Object} EocdInfo
 * @property {number} offset             absolute offset of the EOCD record
 * @property {number} entriesDeclared    total entry count as declared
 * @property {number} cdSize             declared central directory size
 * @property {number} cdOffset           declared central directory offset
 * @property {number} commentLength
 * @property {boolean} zip64
 * @property {Array<{code:string,severity:string,message:string}>} issues
 */

/**
 * Locate the End Of Central Directory record.
 * Scans backwards inside the legal comment window (65,535 bytes + 22).
 * @param {Uint8Array} u8
 * @returns {EocdInfo | null} null when no EOCD signature exists at all
 */
export function findEocd(u8) {
  const issues = [];
  const len = u8.length;
  if (len < EOCD_MIN) return null;
  const start = Math.max(0, len - EOCD_MAX_SEARCH);
  let at = -1;
  for (let i = len - EOCD_MIN; i >= start; i--) {
    if (u32(u8, i) === SIG_EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;

  let entriesDeclared = u16(u8, at + 10);
  let cdSize = u32(u8, at + 12);
  let cdOffset = u32(u8, at + 16);
  const commentLength = u16(u8, at + 20);
  let zip64 = false;

  if (at + EOCD_MIN + commentLength > len) {
    issues.push({
      code: 'eocd-comment-overrun',
      severity: 'warning',
      message: `EOCD declares a ${commentLength}-byte comment but only ${len - at - EOCD_MIN} bytes remain`,
    });
  }
  if (entriesDeclared === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    issues.push({
      code: 'zip64-detected',
      severity: 'info',
      message: 'saturated EOCD fields — ZIP64 records expected',
    });
  }

  // ZIP64: locator sits immediately before the classic EOCD.
  const locAt = at - 20;
  if (locAt >= 0 && u32(u8, locAt) === SIG_EOCD64_LOC) {
    const z64At = u64(u8, locAt + 8);
    if (z64At + 56 <= len && u32(u8, z64At) === SIG_EOCD64) {
      entriesDeclared = u64(u8, z64At + 32);
      cdSize = u64(u8, z64At + 40);
      cdOffset = u64(u8, z64At + 48);
      zip64 = true;
    } else {
      issues.push({
        code: 'zip64-locator-dangling',
        severity: 'error',
        message: `ZIP64 locator points at ${z64At}, which is not a ZIP64 EOCD record`,
      });
    }
  }

  return { offset: at, entriesDeclared, cdSize, cdOffset, commentLength, zip64, issues };
}

/**
 * @typedef {Object} CentralEntry
 * @property {number} index
 * @property {string} name
 * @property {number} nameBytes
 * @property {number} flags
 * @property {number} method
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} localOffset
 * @property {number} recordOffset
 * @property {number} madeBy
 * @property {number} externalAttrs
 * @property {boolean} zip64
 */

/**
 * Walk the central directory. Stops cleanly on the first structural break so a
 * partially readable index degrades instead of throwing.
 * @param {Uint8Array} u8
 * @param {EocdInfo} eocd
 */
export function parseCentralDirectory(u8, eocd) {
  /** @type {CentralEntry[]} */
  const entries = [];
  const issues = [];
  const { cdOffset, cdSize, entriesDeclared } = eocd;
  const len = u8.length;

  if (cdOffset > len) {
    issues.push({
      code: 'cd-offset-out-of-range',
      severity: 'critical',
      message: `central directory offset ${cdOffset} is beyond end of file (${len} bytes)`,
    });
    return { entries, issues, complete: false };
  }
  if (cdOffset + cdSize > len) {
    issues.push({
      code: 'cd-size-out-of-range',
      severity: 'critical',
      message: `central directory spans ${cdOffset}..${cdOffset + cdSize} but file ends at ${len} (truncated)`,
    });
  }

  let at = cdOffset;
  let complete = true;
  for (let i = 0; i < entriesDeclared; i++) {
    if (at + CENTRAL_MIN > len) {
      issues.push({
        code: 'cd-truncated',
        severity: 'critical',
        message: `central directory ends after ${i}/${entriesDeclared} entries`,
      });
      complete = false;
      break;
    }
    const sig = u32(u8, at);
    if (sig !== SIG_CENTRAL) {
      issues.push({
        code: 'cd-signature-invalid',
        severity: 'critical',
        message: `entry ${i}: expected central header signature at ${at}, found 0x${sig.toString(16)}`,
      });
      complete = false;
      break;
    }
    const flags = u16(u8, at + 8);
    const method = u16(u8, at + 10);
    const crc = u32(u8, at + 16);
    let compressedSize = u32(u8, at + 20);
    let uncompressedSize = u32(u8, at + 24);
    const nameLen = u16(u8, at + 28);
    const extraLen = u16(u8, at + 30);
    const commentLen = u16(u8, at + 32);
    let localOffset = u32(u8, at + 42);
    const recordOffset = at;
    const nameStart = at + CENTRAL_MIN;
    const extraStart = nameStart + nameLen;

    if (extraStart + extraLen + commentLen > len) {
      issues.push({
        code: 'cd-entry-overrun',
        severity: 'error',
        message: `entry ${i} ("${decodeName(u8.subarray(nameStart, nameStart + nameLen), true)}") runs past EOF`,
      });
      complete = false;
      break;
    }

    const nameBytes = u8.subarray(nameStart, nameStart + nameLen);
    let zip64 = false;
    // ZIP64 extended information extra field (0x0001) carries the real values in
    // a fixed order, only for the fields that were saturated in the fixed part.
    for (let e = extraStart; e + 4 <= extraStart + extraLen; ) {
      const id = u16(u8, e);
      const size = u16(u8, e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        if (uncompressedSize === 0xffffffff && p + 8 <= e + 4 + size) {
          uncompressedSize = u64(u8, p);
          p += 8;
        }
        if (compressedSize === 0xffffffff && p + 8 <= e + 4 + size) {
          compressedSize = u64(u8, p);
          p += 8;
        }
        if (localOffset === 0xffffffff && p + 8 <= e + 4 + size) {
          localOffset = u64(u8, p);
          p += 8;
        }
        zip64 = true;
      }
      if (size === 0 && id !== 0) break; // malformed: avoid infinite loop
      e += 4 + size;
    }

    entries.push({
      index: i,
      name: decodeName(nameBytes, flags & 0x800),
      nameBytes,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      recordOffset,
      madeBy: u16(u8, at + 4),
      externalAttrs: u32(u8, at + 38),
      zip64,
    });
    at = extraStart + extraLen + commentLen;
  }

  if (entries.length !== entriesDeclared && complete) {
    issues.push({
      code: 'cd-count-mismatch',
      severity: 'warning',
      message: `EOCD declares ${entriesDeclared} entries, central directory yielded ${entries.length}`,
    });
  }
  return { entries, issues, complete };
}

/**
 * @typedef {Object} LocalHeader
 * @property {number} offset
 * @property {number} flags
 * @property {number} method
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {string} name
 * @property {number} dataOffset
 * @property {number} dataDescriptorBytes  bytes reserved by a data descriptor, if any
 * @property {boolean} plausible
 */

/**
 * Read a local file header at an absolute offset.
 * @param {Uint8Array} u8
 * @param {number} offset
 * @param {number} [limit] treat bytes at/after this offset as unavailable
 * @returns {LocalHeader | null}
 */
export function parseLocalHeader(u8, offset, limit = u8.length) {
  if (offset < 0 || offset + LOCAL_MIN > limit) return null;
  if (u32(u8, offset) !== SIG_LOCAL) return null;
  const flags = u16(u8, offset + 6);
  const method = u16(u8, offset + 8);
  const crc = u32(u8, offset + 14);
  const compressedSize = u32(u8, offset + 18);
  const uncompressedSize = u32(u8, offset + 22);
  const nameLen = u16(u8, offset + 26);
  const extraLen = u16(u8, offset + 28);
  const dataOffset = offset + LOCAL_MIN + nameLen + extraLen;
  if (dataOffset > limit) return null;
  return {
    offset,
    flags,
    method,
    crc,
    compressedSize,
    uncompressedSize,
    name: decodeName(u8.subarray(offset + LOCAL_MIN, offset + LOCAL_MIN + nameLen), flags & 0x800),
    dataOffset,
    dataDescriptorBytes: flags & 0x8 ? 16 : 0,
    plausible: dataOffset <= limit,
  };
}
