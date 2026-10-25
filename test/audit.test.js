import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import { audit } from '../src/index.js';
import { findEocd } from '../src/core/parse.js';
import { buildArchive, flipBit, payloadOffset } from './helpers/craft.js';

const enc = new TextEncoder();
const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200);

function codes(report) {
  return report.findings.map((f) => f.code);
}

test('clean archive: every entry verified, exit 0', () => {
  const zip = buildArchive([
    { name: 'notes.txt', data: text, method: 8 },
    { name: 'raw.bin', data: new Uint8Array([0, 1, 2, 3, 250]), method: 0 },
    { name: 'empty.txt', data: new Uint8Array(0), method: 8 },
  ]);
  const r = audit(zip, { name: 'clean.zip' });
  assert.equal(r.summary.verdict, 'clean');
  assert.equal(r.summary.exitCode, 0);
  assert.equal(r.summary.entries, 3);
  assert.equal(r.summary.verified, 3);
  assert.equal(r.file.name, 'clean.zip');
  for (const e of r.entries) {
    assert.equal(e.status, 'verified', e.name);
    assert.equal(e.crc.ok, true, e.name);
    assert.equal(e.sizes.uncompressedActual, e.sizes.uncompressedDeclared, e.name);
  }
});

test('stored entry with one flipped bit is reported as CRC mismatch', () => {
  const zip = buildArchive([{ name: 'photo.dat', data: new Uint8Array(4000).fill(0x5a), method: 0 }]);
  const broken = flipBit(zip, payloadOffset(zip) + 1234);
  const r = audit(broken);
  assert.equal(r.summary.verdict, 'corrupt');
  assert.equal(r.summary.exitCode, 4);
  assert.equal(r.entries[0].status, 'error');
  assert.equal(r.entries[0].crc.ok, false);
  assert.deepEqual(r.entries[0].issues, ['crc-mismatch']);
  assert.match(r.findings.find((f) => f.code === 'crc-mismatch').message, /CRC-32 mismatch/);
});

test('a deflate stream that decodes cleanly but carries different bytes is caught by CRC', () => {
  // The decoder cannot detect this: both payloads are valid deflate streams of
  // identical length. Only the stored CRC distinguishes them.
  const original = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const swapped = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const zip = buildArchive([
    { name: 'a.txt', data: original, body: deflateSync(enc.encode(swapped), { level: 6 }), usize: original.length },
  ]);
  const r = audit(zip);
  assert.equal(r.entries[0].status, 'error');
  assert.equal(r.entries[0].crc.ok, false);
  assert.equal(r.entries[0].sizes.uncompressedActual, original.length, 'payload still decoded');
  assert.equal(r.summary.verdict, 'corrupt');
});

test('with --no-crc the same swapped payload passes — documenting upstream behaviour', () => {
  const original = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const swapped = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const zip = buildArchive([
    { name: 'a.txt', data: original, body: deflateSync(enc.encode(swapped), { level: 6 }), usize: original.length },
  ]);
  const r = audit(zip, { verifyCrc: false });
  assert.ok(!codes(r).includes('crc-mismatch'));
  assert.equal(r.entries[0].crc.ok, null);
  assert.equal(r.summary.verdict, 'clean');
});

test('payload cut short is reported as data out of range', () => {
  const zip = buildArchive([{ name: 'a.txt', data: text }]);
  const cut = zip.subarray(0, payloadOffset(zip) + 10);
  const r = audit(cut);
  assert.ok(codes(r).includes('eocd-missing') || codes(r).includes('data-out-of-range') || codes(r).includes('cd-truncated'));
  assert.notEqual(r.summary.verdict, 'clean');
});

test('central directory CRC that disagrees with the payload is reported', () => {
  const zip = buildArchive([{ name: 'a.txt', data: text, cdCrc: 0xdeadbeef }]);
  const r = audit(zip);
  assert.ok(codes(r).includes('crc-mismatch'));
  assert.equal(r.entries[0].crc.expected, 0xdeadbeef);
  assert.notEqual(r.entries[0].crc.actual, 0xdeadbeef);
});

test('local header name differing from the central directory is an error', () => {
  const zip = buildArchive([{ name: 'real.txt', cdName: 'claimed.txt', data: 'x' }]);
  const r = audit(zip);
  assert.ok(codes(r).includes('local-name-mismatch'));
  assert.equal(r.entries[0].status, 'error');
});

test('local header method differing from the central directory is an error', () => {
  const zip = buildArchive([{ name: 'a.txt', data: text, method: 8 }]);
  // Patch the local header's method field (offset 8) to "stored".
  const patched = zip.slice();
  new DataView(patched.buffer).setUint16(8, 0, true);
  const r = audit(patched);
  assert.ok(codes(r).includes('local-method-mismatch'));
});

test('duplicate entry names warn and keep the verdict at warnings', () => {
  const zip = buildArchive([
    { name: 'same.txt', data: 'first' },
    { name: 'same.txt', data: 'second' },
  ]);
  const r = audit(zip);
  assert.ok(codes(r).includes('duplicate-name'));
  assert.equal(r.summary.verdict, 'warnings');
  assert.equal(r.summary.exitCode, 3);
  assert.equal(r.entries.length, 2, 'both records are still reported');
});

test('path traversal names are flagged as unsafe', () => {
  const zip = buildArchive([{ name: '../../etc/passwd', data: 'x' }]);
  const r = audit(zip);
  const f = r.findings.find((x) => x.code === 'unsafe-path');
  assert.ok(f);
  assert.equal(f.severity, 'error');
});

test('prototype-colliding names produce a warning', () => {
  const zip = buildArchive([{ name: '__proto__', data: 'x' }]);
  const r = audit(zip);
  assert.ok(codes(r).includes('unsafe-name'));
});

test('NUL bytes in a name are critical', () => {
  const zip = buildArchive([{ name: 'bad\u0000name.txt', data: 'x' }]);
  const r = audit(zip);
  const f = r.findings.find((x) => x.code === 'name-contains-nul');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
});

test('unsupported compression method is unverifiable, not "ok"', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'x', method: 12 }]);
  const r = audit(zip);
  assert.equal(r.entries[0].status, 'unverifiable');
  assert.ok(codes(r).includes('unsupported-method'));
  assert.equal(r.summary.unverifiable, 1);
  assert.equal(r.summary.exitCode, 3);
});

test('encrypted entries are reported as unverifiable', () => {
  const zip = buildArchive([{ name: 'secret.txt', data: 'x', flags: 0x801 }]);
  const r = audit(zip);
  assert.equal(r.entries[0].encrypted, true);
  assert.equal(r.entries[0].status, 'unverifiable');
  assert.ok(codes(r).includes('encrypted-entry'));
});

test('a lying uncompressed-size header cannot trigger a large allocation', () => {
  const zip = buildArchive([{ name: 'bomb.txt', data: text, usize: 900 * 1024 * 1024 }]);
  const t0 = Date.now();
  const r = audit(zip, { maxEntryBytes: 1024 * 1024 });
  const elapsed = Date.now() - t0;
  assert.ok(codes(r).includes('expansion-limit'));
  assert.equal(r.findings.find((f) => f.code === 'expansion-limit').severity, 'critical');
  assert.ok(elapsed < 500, `must refuse quickly, took ${elapsed}ms`);
});

test('runaway expansion ratio is flagged even when the size is legal', () => {
  const zeros = new Uint8Array(2 * 1024 * 1024);
  const zip = buildArchive([{ name: 'zeros.bin', data: zeros, method: 8 }]);
  const r = audit(zip, { maxRatio: 10 });
  assert.ok(codes(r).includes('expansion-ratio'));
  assert.equal(r.summary.verdict, 'warnings');
});

test('an empty archive is clean and has no entries', () => {
  const zip = buildArchive([]);
  const r = audit(zip);
  assert.equal(r.summary.entries, 0);
  assert.equal(r.summary.verdict, 'clean');
  assert.equal(r.summary.exitCode, 0);
});

test('non-zip bytes report eocd-missing and exit 5', () => {
  const junk = new Uint8Array(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 13) & 0xff;
  const r = audit(junk);
  assert.ok(codes(r).includes('eocd-missing'));
  assert.equal(r.summary.verdict, 'unreadable');
  assert.equal(r.summary.exitCode, 5);
  assert.equal(r.container.entriesScanned, 0);
});

test('a prepended stub is tolerated and reported', () => {
  const entries = [
    { name: 'a.txt', data: text },
    { name: 'b.bin', data: new Uint8Array([9, 8, 7]), method: 0 },
  ];
  const base = buildArchive(entries);
  const eocd = findEocd(base);
  const stub = 100;
  const out = new Uint8Array(stub + base.length);
  out.set(base, stub);
  // Self-extracting layout: the index offset is absolute (includes the stub) but
  // per-entry local header offsets are not — the exact shape that makes naive
  // readers report "invalid zip data".
  new DataView(out.buffer).setUint32(stub + eocd.offset + 16, eocd.cdOffset + stub, true);
  const r = audit(out);
  assert.equal(r.container.prefixStub, stub);
  assert.ok(codes(r).includes('prefix-stub'));
  assert.ok(codes(r).includes('offset-shift'));
  assert.equal(r.summary.verified, 2, JSON.stringify(r.findings));
  assert.equal(r.summary.verdict, 'warnings');
});

test('data descriptor entries verify and are marked informational', () => {
  const zip = buildArchive([{ name: 'a.txt', data: text, descriptor: true }]);
  const r = audit(zip);
  assert.equal(r.entries[0].status, 'verified');
  assert.ok(codes(r).includes('data-descriptor'));
  assert.equal(r.summary.verdict, 'clean');
});

test('summary counters add up and the report is JSON-stable', () => {
  const zip = buildArchive([
    { name: 'ok.txt', data: text },
    { name: 'bad.bin', data: new Uint8Array(500).fill(7), method: 0 },
    { name: 'weird.txt', data: 'x', method: 12 },
  ]);
  const broken = flipBit(zip, payloadOffset(zip));
  const r = audit(broken);
  assert.equal(r.summary.verified + r.summary.unverifiable + r.summary.corrupt, r.summary.entries);
  // durationMs is a measurement, not content: strip it before comparing.
  const stable = (x) => JSON.stringify({ ...x, summary: { ...x.summary, durationMs: 0 } });
  assert.equal(stable(r), stable(audit(broken)), 'same input must produce identical reports');
  for (const f of r.findings) {
    assert.equal(typeof f.code, 'string');
    assert.equal(typeof f.message, 'string');
    assert.ok(['info', 'warning', 'error', 'critical'].includes(f.severity));
  }
});

test('the archive-wide decode budget stops further entries', () => {
  const zip = buildArchive([
    { name: 'a.bin', data: new Uint8Array(600).fill(1), method: 0 },
    { name: 'b.bin', data: new Uint8Array(600).fill(2), method: 0 },
  ]);
  const r = audit(zip, { maxTotalBytes: 700 });
  assert.ok(r.summary.decodedBytes <= 700);
  assert.ok(codes(r).includes('expansion-limit'));
});
