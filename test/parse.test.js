import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEocd, parseCentralDirectory, parseLocalHeader } from '../src/core/parse.js';
import { buildArchive } from './helpers/craft.js';

const enc = new TextEncoder();

test('parses a well-formed archive end to end', () => {
  const zip = buildArchive([
    { name: 'a.txt', data: 'alpha' },
    { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3, 4]), method: 0 },
  ]);
  const eocd = findEocd(zip);
  assert.ok(eocd);
  assert.equal(eocd.entriesDeclared, 2);
  assert.equal(eocd.issues.length, 0);
  const cd = parseCentralDirectory(zip, eocd);
  assert.equal(cd.complete, true);
  assert.deepEqual(cd.entries.map((e) => e.name), ['a.txt', 'dir/b.bin']);
  assert.equal(cd.entries[0].method, 8);
  assert.equal(cd.entries[1].method, 0);
  assert.equal(cd.entries[1].uncompressedSize, 4);
});

test('findEocd returns null when the signature is absent', () => {
  const junk = new Uint8Array(5000).fill(0x41);
  assert.equal(findEocd(junk), null);
});

test('findEocd tolerates a maximal-length comment', () => {
  const comment = 'x'.repeat(65535);
  const zip = buildArchive([{ name: 'a.txt', data: 'alpha' }], { comment });
  const eocd = findEocd(zip);
  assert.ok(eocd, 'EOCD must still be found inside the legal comment window');
  assert.equal(eocd.commentLength, 65535);
});

test('findEocd reports a comment that overruns EOF', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'alpha' }], { comment: 'abc' });
  const cut = zip.subarray(0, zip.length - 2); // comment now 1 byte short
  const eocd = findEocd(cut);
  assert.ok(eocd);
  assert.ok(eocd.issues.some((i) => i.code === 'eocd-comment-overrun'));
});

test('central directory parsing stops cleanly on a broken signature', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'alpha' }], { corruptCd: true });
  const eocd = findEocd(zip);
  const cd = parseCentralDirectory(zip, eocd);
  assert.equal(cd.complete, false);
  assert.equal(cd.entries.length, 0);
  assert.ok(cd.issues.some((i) => i.code === 'cd-signature-invalid'));
});

test('central directory offset beyond EOF is reported as critical', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'alpha' }], { cdOffset: 999999 });
  const eocd = findEocd(zip);
  const cd = parseCentralDirectory(zip, eocd);
  assert.equal(cd.complete, false);
  assert.ok(cd.issues.some((i) => i.code === 'cd-offset-out-of-range' && i.severity === 'critical'));
});

test('local header reader rejects non-header offsets', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'alpha' }]);
  assert.equal(parseLocalHeader(zip, 1), null);
  const lh = parseLocalHeader(zip, 0);
  assert.ok(lh);
  assert.equal(lh.name, 'a.txt');
  assert.equal(lh.dataOffset, 30 + 'a.txt'.length);
});

test('local header records the data-descriptor flag', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'alpha', descriptor: true }]);
  const lh = parseLocalHeader(zip, 0);
  assert.ok(lh.flags & 0x8);
  assert.equal(lh.dataDescriptorBytes, 16);
});

test('ZIP64 extended information overrides saturated sizes', () => {
  // Hand-build a central record whose 32-bit sizes are saturated and whose
  // extra field carries the real values (APPNOTE 4.5.3 order: usize, csize, offset).
  const name = enc.encode('z64.txt');
  const extra = new Uint8Array(4 + 24);
  const dv = new DataView(extra.buffer);
  dv.setUint16(0, 0x0001, true);
  dv.setUint16(2, 24, true);
  const realUsize = 0x1_0000_0001; // > 4 GiB, still a safe integer
  const realCsize = 0x1_0000_0002;
  const realOffset = 0x1_0000_0003;
  dv.setUint32(4, realUsize & 0xffffffff, true);
  dv.setUint32(8, Math.floor(realUsize / 0x100000000), true);
  dv.setUint32(12, realCsize & 0xffffffff, true);
  dv.setUint32(16, Math.floor(realCsize / 0x100000000), true);
  dv.setUint32(20, realOffset & 0xffffffff, true);
  dv.setUint32(24, Math.floor(realOffset / 0x100000000), true);

  const cdRec = new Uint8Array(46 + name.length + extra.length);
  const v = new DataView(cdRec.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 0x031e, true);
  v.setUint16(6, 45, true);
  v.setUint16(10, 8, true);
  v.setUint32(16, 0x12345678, true);
  v.setUint32(20, 0xffffffff, true);
  v.setUint32(24, 0xffffffff, true);
  v.setUint16(28, name.length, true);
  v.setUint16(30, extra.length, true);
  v.setUint32(42, 0xffffffff, true);
  cdRec.set(name, 46);
  cdRec.set(extra, 46 + name.length);

  // Layout: [CD][ZIP64 EOCD][ZIP64 locator][classic EOCD with saturated fields]
  const z64At = cdRec.length;
  const locAt = z64At + 56;
  const eocdAt = locAt + 20;
  const zip = new Uint8Array(eocdAt + 22);
  zip.set(cdRec, 0);
  const e = new DataView(zip.buffer);
  e.setUint32(z64At, 0x06064b50, true);
  e.setUint32(z64At + 4, 44, true); // size of remaining record
  e.setUint16(z64At + 12, 45, true);
  e.setUint16(z64At + 14, 45, true);
  e.setUint32(z64At + 24, 1, true);
  e.setUint32(z64At + 32, 1, true);
  e.setUint32(z64At + 36, 0, true);
  e.setUint32(z64At + 40, cdRec.length, true);
  e.setUint32(z64At + 44, 0, true);
  e.setUint32(z64At + 48, 0, true);
  e.setUint32(locAt, 0x07064b50, true);
  e.setUint32(locAt + 8, z64At, true);
  e.setUint32(locAt + 16, 1, true);
  e.setUint32(eocdAt, 0x06054b50, true);
  e.setUint16(eocdAt + 8, 0xffff, true);
  e.setUint16(eocdAt + 10, 0xffff, true);
  e.setUint32(eocdAt + 12, 0xffffffff, true);
  e.setUint32(eocdAt + 16, 0xffffffff, true);

  const eocd = findEocd(zip);
  assert.ok(eocd.issues.some((i) => i.code === 'zip64-detected'), 'saturated EOCD fields must be flagged');
  assert.equal(eocd.zip64, true);
  assert.equal(eocd.cdOffset, 0);
  assert.equal(eocd.entriesDeclared, 1);
  const cd = parseCentralDirectory(zip, eocd);
  assert.equal(cd.entries.length, 1);
  assert.equal(cd.entries[0].zip64, true);
  assert.equal(cd.entries[0].uncompressedSize, realUsize);
  assert.equal(cd.entries[0].compressedSize, realCsize);
  assert.equal(cd.entries[0].localOffset, realOffset);
});

test('a dangling ZIP64 locator is reported instead of trusted', () => {
  const base = buildArchive([{ name: 'a.txt', data: 'alpha' }]);
  const eocd = findEocd(base);
  const body = base.subarray(0, eocd.offset);
  const out = new Uint8Array(body.length + 20 + 22);
  out.set(body, 0);
  const v = new DataView(out.buffer);
  v.setUint32(body.length, 0x07064b50, true); // locator
  v.setUint32(body.length + 8, 123456, true); // points nowhere
  v.setUint32(body.length + 16, 1, true); // total disks
  out.set(base.subarray(eocd.offset), body.length + 20);
  v.setUint16(body.length + 20 + 8, 0xffff, true); // saturate the entry count
  v.setUint16(body.length + 20 + 10, 0xffff, true);

  const found = findEocd(out);
  assert.ok(found);
  assert.ok(found.issues.some((i) => i.code === 'zip64-locator-dangling'), JSON.stringify(found.issues));
  assert.equal(found.zip64, false);
});
