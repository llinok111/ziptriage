/**
 * CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — the checksum used by ZIP.
 * Implemented here rather than imported so the container layer stays dependency-free
 * and can verify entries while streaming (fflate only computes CRC when writing).
 */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} bytes @param {number} [seed] @returns {number} unsigned 32-bit */
export function crc32(bytes, seed = 0) {
  let c = (~seed) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

/** Incremental CRC helper for chunked decoding. */
export function createCrc32() {
  let c = 0xffffffff;
  return {
    update(bytes) {
      for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
      return this;
    },
    digest() {
      return (~c) >>> 0;
    },
  };
}

export function crcHex(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}
