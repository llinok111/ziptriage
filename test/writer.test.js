import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import { audit, buildZip } from '../src/index.js';
import { buildZip as buildZipCore } from '../src/core/writer.js';

const enc = new TextEncoder();

test('the writer produces archives the auditor accepts', () => {
  const files = [
    { name: 'a.txt', data: enc.encode('hello '.repeat(200)) },
    { name: 'b.bin', data: new Uint8Array(300) },
    { name: '中文/名字.txt', data: enc.encode('unicode name') },
  ];
  const zip = buildZip(files, { codec: { deflateSync } });
  const r = audit(zip);
  assert.equal(r.summary.verdict, 'clean', JSON.stringify(r.findings));
  assert.equal(r.summary.entries, 3);
  assert.deepEqual(r.entries.map((e) => e.name), ['a.txt', 'b.bin', '中文/名字.txt']);
});

test('an empty file list yields a valid empty archive', () => {
  const zip = buildZip([], { codec: { deflateSync } });
  assert.equal(zip.length, 22, 'just the EOCD record');
  const r = audit(zip);
  assert.equal(r.summary.entries, 0);
  assert.equal(r.summary.verdict, 'clean');
});

test('incompressible data falls back to stored', () => {
  // xorshift32: no short period, so deflate cannot find structure to exploit.
  const random = new Uint8Array(4096);
  let x = 0x9e3779b9;
  for (let i = 0; i < random.length; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    random[i] = x & 0xff;
  }
  const zip = buildZip([{ name: 'noise.bin', data: random }], { codec: { deflateSync } });
  const r = audit(zip);
  assert.equal(r.entries[0].method, 0, 'stored wins when deflate cannot shrink');
  assert.equal(r.entries[0].status, 'verified');
});

test('output is byte-identical across runs (no timestamps, no ordering drift)', () => {
  const files = [
    { name: 'x.txt', data: enc.encode('x') },
    { name: 'y.txt', data: enc.encode('y') },
  ];
  const a = buildZipCore(files, { codec: { deflateSync } });
  const b = buildZipCore(files, { codec: { deflateSync } });
  assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0);
});

test('the writer requires a codec instead of importing one', () => {
  assert.throws(() => buildZipCore([], {}), /deflateSync/);
});
