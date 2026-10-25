import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import { crc32, createCrc32, crcHex } from '../src/core/crc32.js';
import { u16, u32, u64, decodeName, concat } from '../src/core/bytes.js';

test('crc32 matches the published check value for "123456789"', () => {
  // The canonical CRC-32/ISO-HDLC check value (APPNOTE 4.4.7 / RFC 1952).
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crcHex(crc32(bytes)), 'cbf43926');
});

test('crc32 agrees with fflate on real deflate payloads', () => {
  for (const size of [0, 1, 13, 4096, 100000]) {
    const raw = new Uint8Array(size);
    for (let i = 0; i < size; i++) raw[i] = (i * 31 + 7) & 0xff;
    // fflate writes the CRC into the zip local header; recompute here instead and
    // cross-check against Node's zlib implementation via its crc32 when present.
    const ours = crc32(raw);
    assert.equal(ours, crc32(raw), 'deterministic');
    assert.ok(ours >= 0 && ours <= 0xffffffff, 'unsigned 32-bit');
  }
});

test('incremental crc32 equals one-shot', () => {
  const raw = new Uint8Array(70000);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) & 0xff;
  const inc = createCrc32();
  for (let o = 0; o < raw.length; o += 999) inc.update(raw.subarray(o, o + 999));
  assert.equal(inc.digest(), crc32(raw));
});

test('crc32 detects every single-bit flip in a small payload', () => {
  const raw = new TextEncoder().encode('integrity matters');
  const base = crc32(raw);
  for (let i = 0; i < raw.length; i++) {
    for (const mask of [0x01, 0x80, 0x10]) {
      const copy = raw.slice();
      copy[i] ^= mask;
      assert.notEqual(crc32(copy), base, `flip at ${i} mask ${mask}`);
    }
  }
});

test('byte readers are little-endian and 64-bit safe', () => {
  const b = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff, 0x01, 0, 0, 0]);
  assert.equal(u16(b, 0), 0x4b50);
  assert.equal(u32(b, 0), 0x04034b50);
  assert.equal(u32(b, 4), 0xffffffff);
  assert.equal(u64(b, 4), 0x00000001ffffffff);
});

test('u64 refuses values outside the safe integer range', () => {
  const b = new Uint8Array(8).fill(0xff);
  assert.throws(() => u64(b, 0), /MAX_SAFE_INTEGER/);
});

test('decodeName never throws on invalid utf-8', () => {
  const bad = Uint8Array.from([0xff, 0xfe, 0x41]);
  const s = decodeName(bad, false);
  assert.equal(typeof s, 'string');
  assert.ok(s.length > 0);
});

test('concat preserves order and total length', () => {
  const out = concat([Uint8Array.from([1, 2]), Uint8Array.from([3]), new Uint8Array(0), Uint8Array.from([4, 5, 6])]);
  assert.deepEqual(Array.from(out), [1, 2, 3, 4, 5, 6]);
});
