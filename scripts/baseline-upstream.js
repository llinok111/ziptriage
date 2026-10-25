#!/usr/bin/env node
/**
 * Reproducible baseline of upstream behaviour.
 *
 * Every claim in docs/UPSTREAM.md maps to one line of output here. Run it before
 * and after any change; the numbers must not drift.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { buildArchive, flipBit, payloadOffset } from '../test/helpers/craft.js';
import { audit } from '../src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs');
mkdirSync(out, { recursive: true });

const enc = new TextEncoder();
const stored = enc.encode('STORED-PAYLOAD-'.repeat(1000));
const cases = [];

// A. stored entry, one bit flipped in the payload
const goodStored = buildArchive([{ name: 'img.dat', data: stored, method: 0 }]);
const badStored = flipBit(goodStored, payloadOffset(goodStored) + 100);
let upstreamStored;
try {
  const files = unzipSync(badStored);
  const got = Buffer.from(files['img.dat']);
  let diff = 0;
  for (let i = 0; i < stored.length; i++) if (stored[i] !== got[i]) diff++;
  upstreamStored = { threw: false, bytes: got.length, differingBytes: diff };
} catch (e) {
  upstreamStored = { threw: true, code: e.code, message: e.message };
}
cases.push({
  id: 'stored-bitflip',
  claim: 'unzipSync returns corrupt bytes without error',
  upstream: upstreamStored,
  ziptriage: (() => {
    const r = audit(badStored);
    return { verdict: r.summary.verdict, exitCode: r.summary.exitCode, findings: r.findings.map((f) => f.code) };
  })(),
});

// B. deflate stream damaged mid-way (midpoint of the declared compressed size)
const text = enc.encode('The quick brown fox jumps over the lazy dog. '.repeat(4000));
const goodDeflate = buildArchive([{ name: 'doc.txt', data: text, method: 8 }]);
const dv = new DataView(goodDeflate.buffer, goodDeflate.byteOffset, goodDeflate.byteLength);
const csize = dv.getUint32(18, true);
const flipAt = payloadOffset(goodDeflate) + Math.floor(csize / 2);
const badDeflate = flipBit(goodDeflate, flipAt);
let upstreamDeflate;
try {
  const files = unzipSync(badDeflate);
  const got = Buffer.from(files['doc.txt']);
  let diff = 0;
  for (let i = 0; i < text.length; i++) if (text[i] !== got[i]) diff++;
  upstreamDeflate = { threw: false, bytes: got.length, differingBytes: diff };
} catch (e) {
  upstreamDeflate = { threw: true, code: e.code, message: e.message };
}
cases.push({
  id: 'deflate-bitflip',
  claim: `one bit flipped at payload+${Math.floor(csize / 2)} of ${csize} compressed bytes`,
  upstream: upstreamDeflate,
  ziptriage: (() => {
    const r = audit(badDeflate);
    return { verdict: r.summary.verdict, findings: r.findings.filter((f) => f.severity !== 'info').map((f) => f.code) };
  })(),
});

// C. central directory destroyed
const files3 = [
  { name: 'a.txt', data: enc.encode('alpha '.repeat(300)) },
  { name: 'b.bin', data: new Uint8Array(4000).fill(7), method: 0 },
  { name: 'c.txt', data: enc.encode('gamma') },
];
const cdBroken = buildArchive(files3, { corruptCd: true });
let upstreamCd;
try {
  upstreamCd = { threw: false, names: Object.keys(unzipSync(cdBroken)) };
} catch (e) {
  upstreamCd = { threw: true, code: e.code, message: e.message };
}
cases.push({
  id: 'cd-destroyed',
  claim: 'no salvage path: the whole archive is rejected',
  upstream: upstreamCd,
  ziptriage: (() => {
    const r = audit(cdBroken);
    return { verdict: r.summary.verdict, recoverableViaScan: r.container.entriesScanned };
  })(),
});

// D. truncated tail
const truncated = buildArchive(files3, { truncateTail: 60 });
let upstreamTrunc;
try {
  upstreamTrunc = { threw: false, names: Object.keys(unzipSync(truncated)) };
} catch (e) {
  upstreamTrunc = { threw: true, code: e.code, message: e.message };
}
cases.push({
  id: 'truncated',
  claim: 'numeric error code 13 only, no indication of what survived',
  upstream: upstreamTrunc,
  ziptriage: (() => {
    const r = audit(truncated);
    return { verdict: r.summary.verdict, recoverableViaScan: r.container.entriesScanned, codes: r.findings.map((f) => f.code) };
  })(),
});

// E. duplicate names collide in the returned object
const dup = buildArchive([
  { name: 'same.txt', data: 'FIRST' },
  { name: 'same.txt', data: 'SECOND' },
]);
let upstreamDup;
try {
  const files = unzipSync(dup);
  upstreamDup = { threw: false, keys: Object.keys(files), value: new TextDecoder().decode(files['same.txt']) };
} catch (e) {
  upstreamDup = { threw: true, code: e.code, message: e.message };
}
cases.push({
  id: 'duplicate-names',
  claim: 'last entry silently wins; the first is unreachable',
  upstream: upstreamDup,
  ziptriage: (() => {
    const r = audit(dup);
    return { verdict: r.summary.verdict, codes: r.findings.map((f) => f.code), entries: r.summary.entries };
  })(),
});

// F. fflate's own ZIP round-trip still works (no regression introduced upstream)
const rt = zipSync({ 'x.txt': strToU8('hello') });
const rtOut = unzipSync(rt);
cases.push({
  id: 'roundtrip-control',
  claim: 'healthy archives keep working',
  upstream: { threw: false, value: new TextDecoder().decode(rtOut['x.txt']) },
  ziptriage: (() => {
    const r = audit(rt);
    return { verdict: r.summary.verdict };
  })(),
});

const doc = {
  generatedBy: 'scripts/baseline-upstream.js',
  fflateVersion: JSON.parse(readFileSync(join(root, 'node_modules', 'fflate', 'package.json'), 'utf8')).version,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  cases,
};
writeFileSync(join(out, 'BASELINE.json'), `${JSON.stringify(doc, null, 2)}\n`);

for (const c of cases) {
  console.log(`\n# ${c.id} — ${c.claim}`);
  console.log('  upstream:', JSON.stringify(c.upstream));
  console.log('  triage  :', JSON.stringify(c.ziptriage));
}
console.log(`\nwrote docs/BASELINE.json (${cases.length} cases)`);
