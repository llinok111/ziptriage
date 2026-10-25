import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'fflate';
import { audit, salvage } from '../src/index.js';
import { safeName } from '../src/core/salvage.js';
import { findEocd, parseCentralDirectory } from '../src/core/parse.js';
import { buildArchive, flipBit, payloadOffset } from './helpers/craft.js';

const enc = new TextEncoder();
const doc = enc.encode('line of text\n'.repeat(600));
const bin = new Uint8Array(3000);
for (let i = 0; i < bin.length; i++) bin[i] = (i * 97) & 0xff;

const FILES = [
  { name: 'docs/readme.txt', data: doc, method: 8 },
  { name: 'assets/blob.bin', data: bin, method: 0 },
  { name: 'empty.txt', data: new Uint8Array(0), method: 8 },
];

test('salvage rebuilds a truncated archive completely', () => {
  const good = buildArchive(FILES);
  const cut = good.subarray(0, good.length - 90);
  assert.equal(audit(cut).summary.verdict, 'unreadable', 'precondition: index is gone');

  const r = salvage(cut);
  assert.equal(r.summary.recovered, 3);
  assert.equal(r.summary.dropped, 0);
  assert.ok(r.source.entriesFromScanOnly >= 3, 'all entries must come from the header scan');
  assert.equal(r.summary.selfCheck.verdict, 'clean');
  assert.equal(r.summary.selfCheck.entries, 3);

  const byName = new Map(r.recovered.map((x) => [x.name, x]));
  assert.deepEqual(Buffer.from(byName.get('docs/readme.txt').data), Buffer.from(doc));
  assert.deepEqual(Buffer.from(byName.get('assets/blob.bin').data), Buffer.from(bin));
  assert.equal(byName.get('empty.txt').bytes, 0);
  for (const e of r.recovered) assert.equal(e.grade, 'verified');
});

test('salvage rebuilds an archive whose central directory was overwritten', () => {
  const good = buildArchive(FILES, { corruptCd: true });
  const before = audit(good);
  assert.equal(before.container.entriesParsed, 0);
  assert.ok(before.findings.some((f) => f.code === 'cd-signature-invalid'));

  const r = salvage(good);
  assert.equal(r.summary.recovered, 3);
  assert.equal(r.summary.selfCheck.verdict, 'clean');
  const reaudit = audit(r.archive);
  assert.equal(reaudit.summary.verdict, 'clean');
  assert.equal(reaudit.summary.errors, 0);
});

test('salvage keeps the healthy entries when one stream is damaged', () => {
  const good = buildArchive(FILES);
  const eocd = findEocd(good);
  const { entries } = parseCentralDirectory(good, eocd);
  // Damage the middle of the second entry's deflate stream: the Huffman tree
  // breaks, so the decoder fails instead of returning quietly wrong bytes.
  const damaged = flipBit(good, payloadOffset(good, entries[1].localOffset) + 200);
  const pre = audit(damaged);
  assert.equal(pre.entries[1].status, 'error', JSON.stringify(pre.findings));

  const r = salvage(damaged, { selfVerify: true });
  assert.ok(r.summary.recovered >= 2, `expected the healthy entries, got ${r.summary.recovered}`);
  // The damaged entry is either kept as "partial" (bytes decoded before the
  // break) or dropped with a reason — never reported as verified.
  if (r.dropped.length === 0) {
    assert.ok(r.summary.partial >= 1, 'damage must surface either as partial or as dropped');
  }
  assert.equal(r.summary.selfCheck.verdict, 'clean', 'whatever is packed must itself be valid');
  // Nothing recovered may be silently mislabelled as verified.
  for (const e of r.recovered) {
    assert.ok(['verified', 'partial'].includes(e.grade));
    if (e.grade === 'verified') assert.equal(e.crc.actual, e.crc.expected);
  }
});

test('recovered bytes are byte-identical to the originals', () => {
  const good = buildArchive(FILES);
  const cut = good.subarray(0, good.length - 90);
  const r = salvage(cut);
  for (const f of FILES) {
    const got = r.recovered.find((x) => x.name === f.name);
    assert.ok(got, `${f.name} missing`);
    assert.deepEqual(Array.from(got.data), Array.from(f.data), `${f.name} content mismatch`);
  }
});

test('salvage output is deterministic', () => {
  const good = buildArchive(FILES, { corruptCd: true });
  const a = salvage(good).archive;
  const b = salvage(good).archive;
  assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, 'two runs must produce identical bytes');
});

test('unsafe names are sanitised on repack and the rename is reported', () => {
  const evil = buildArchive([
    { name: '../../../etc/passwd', data: 'root:x:0:0' },
    { name: '/absolute.txt', data: 'abs' },
    { name: 'C:\\windows\\system32\\evil.dll', data: 'dll' },
    { name: 'dup.txt', data: 'one' },
    { name: 'dup.txt', data: 'two' },
  ]);
  const r = salvage(evil);
  const names = r.files.map((f) => f.name);
  assert.ok(names.includes('etc/passwd'), names.join(','));
  assert.ok(names.includes('absolute.txt'), names.join(','));
  assert.ok(names.includes('windows/system32/evil.dll'), names.join(','));
  assert.equal(names.filter((n) => n === 'dup.txt').length, 1, 'duplicate names must not collide on disk');
  assert.ok(names.some((n) => n.startsWith('dup.txt~')), names.join(','));
  assert.ok(r.renamed.length >= 4, JSON.stringify(r.renamed));
  assert.ok(r.renamed.some((x) => x.from.includes('..')));
  // No name may escape the extraction root.
  for (const n of names) {
    assert.ok(!n.startsWith('/'));
    assert.ok(!n.includes('..'));
    assert.ok(!/^[a-zA-Z]:/.test(n));
  }
});

test('safeName collapses traversal segments and de-duplicates', () => {
  const used = new Set();
  assert.equal(safeName('../../etc/passwd', used), 'etc/passwd');
  assert.equal(safeName('/a//b/./c.txt', used), 'a/b/c.txt');
  assert.equal(safeName('', used), 'recovered.bin');
  assert.equal(safeName('x.txt', used), 'x.txt');
  assert.equal(safeName('x.txt', used), 'x.txt~2');
});

test('salvage on random bytes recovers nothing and does not throw', () => {
  const junk = new Uint8Array(2048);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 41) & 0xff;
  const r = salvage(junk);
  assert.equal(r.summary.recovered, 0);
  assert.equal(r.summary.dropped, 0);
  assert.ok(r.archive, 'an empty but valid archive is still produced');
  assert.equal(audit(r.archive).summary.verdict, 'clean');
});

test('zero-byte entries recovered by header scan count as verified, not partial', () => {
  // Regression: `compressedSize === 0` was treated as "sizes unknown", so every
  // empty entry was downgraded to partial even though its CRC (0) matched.
  const zip = buildArchive([
    { name: 'empty-a.txt', data: new Uint8Array(0) },
    { name: 'full.txt', data: 'x'.repeat(500) },
    { name: 'empty-b.bin', data: new Uint8Array(0), method: 0 },
  ], { corruptCd: true });
  const r = salvage(zip);
  assert.equal(r.summary.recovered, 3);
  assert.equal(r.summary.partial, 0, JSON.stringify(r.recovered.map((x) => [x.name, x.grade])));
  assert.equal(r.summary.verified, 3);
});

test('the salvage budget is enforced and reported', () => {
  const big = buildArchive([
    { name: 'a.bin', data: new Uint8Array(5000).fill(1), method: 0 },
    { name: 'b.bin', data: new Uint8Array(5000).fill(2), method: 0 },
  ], { corruptCd: true });
  const r = salvage(big, { maxTotalBytes: 6000 });
  assert.ok(r.summary.bytes <= 6000);
  assert.ok(r.dropped.some((d) => /budget/.test(d.reason)), JSON.stringify(r.dropped));
});

test('a partial deflate stream keeps the bytes decoded before the damage', () => {
  // Build a stream, then truncate it in the middle: the decoder emits whole
  // blocks before it runs out of input.
  const payload = enc.encode('0123456789abcdef'.repeat(4000));
  const full = deflateSync(payload, { level: 6 });
  const half = full.subarray(0, Math.floor(full.length * 0.6));
  const zip = buildArchive([{ name: 'cut.txt', data: payload, body: half, csize: half.length }], { omitEocd: true });
  const r = salvage(zip);
  const rec = r.recovered.find((x) => x.name === 'cut.txt');
  assert.ok(rec, 'partial content should still be recovered');
  assert.ok(rec.bytes > 0);
  assert.ok(rec.bytes < payload.length, 'must not claim more bytes than existed');
  assert.equal(rec.grade, 'partial');
});
