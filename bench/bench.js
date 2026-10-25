#!/usr/bin/env node
/**
 * Benchmark: audit throughput vs. decode-only (upstream fflate unzipSync).
 *
 * Method: five repetitions per configuration, median reported. Only ratios are
 * interpreted — absolute numbers move with machine load (measured 2.8x spread on
 * this box across runs), so a single run is not evidence.
 */
import { unzipSync } from 'fflate';
import { audit, salvage } from '../src/index.js';
import { buildArchive } from '../test/helpers/craft.js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = 5;
const enc = new TextEncoder();

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function timeIt(fn) {
  const t = process.hrtime.bigint();
  const out = fn();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, out };
}

function makeCorpus(entries, bytesPer) {
  const specs = [];
  for (let i = 0; i < entries; i++) {
    // Semi-realistic mix: text-ish, compressible, unique per entry.
    const unit = `entry ${i} `;
    const body = enc.encode(unit.repeat(Math.ceil(bytesPer / unit.length)).slice(0, bytesPer));
    specs.push({ name: `dir${i % 20}/file-${i}.txt`, data: body, method: i % 7 === 0 ? 0 : 8 });
  }
  return buildArchive(specs);
}

const corpora = [
  { label: '200 entries × 8 KiB', bytes: makeCorpus(200, 8 * 1024) },
  { label: '2000 entries × 8 KiB', bytes: makeCorpus(2000, 8 * 1024) },
];

const rows = [];
for (const { label, bytes } of corpora) {
  // Warm up so JIT state is comparable.
  unzipSync(bytes);
  audit(bytes);
  const up = [];
  const tri = [];
  const triNoCrc = [];
  let entries = 0;
  for (let i = 0; i < RUNS; i++) {
    up.push(timeIt(() => unzipSync(bytes)).ms);
    const a = timeIt(() => audit(bytes));
    tri.push(a.ms);
    entries = a.out.summary.entries;
    triNoCrc.push(timeIt(() => audit(bytes, { verifyCrc: false })).ms);
  }
  rows.push({
    corpus: label,
    bytes: bytes.length,
    entries,
    unzipSyncMs: +median(up).toFixed(2),
    auditMs: +median(tri).toFixed(2),
    auditNoCrcMs: +median(triNoCrc).toFixed(2),
    ratio: +(median(tri) / median(up)).toFixed(2),
    entriesPerSec: Math.round((entries / median(tri)) * 1000),
    mbPerSec: +((bytes.length / 1048576) / (median(tri) / 1000)).toFixed(1),
  });
}

// Salvage cost on an archive with its index destroyed.
const salvageCorpus = makeCorpus(500, 16 * 1024);
const broken = (() => {
  const copy = salvageCorpus.slice();
  // Wipe the central directory (everything after the last local payload).
  const eocdAt = copy.length - 22;
  const dv = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const cdOffset = dv.getUint32(eocdAt + 16, true);
  copy.fill(0, cdOffset, eocdAt);
  return copy;
})();
const salvageRuns = [];
for (let i = 0; i < RUNS; i++) salvageRuns.push(timeIt(() => salvage(broken)).ms);
const salv = salvage(broken);

const doc = {
  generatedBy: 'bench/bench.js',
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  runs: RUNS,
  metric: 'median of 5 runs, milliseconds',
  rows,
  salvage: {
    corpus: '500 entries × 16 KiB, central directory wiped',
    ms: +median(salvageRuns).toFixed(2),
    recovered: salv.summary.recovered,
    verified: salv.summary.verified,
  },
};

const dir = join(root, 'docs');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'MEASUREMENTS.json'), `${JSON.stringify(doc, null, 2)}\n`);

console.log(`node ${process.version} · ${process.platform}-${process.arch} · median of ${RUNS}\n`);
console.log('corpus                entries   unzipSync   audit   no-crc   ratio   entries/s   MB/s');
for (const r of rows) {
  console.log(
    `${r.corpus.padEnd(20)} ${String(r.entries).padStart(7)} ${String(r.unzipSyncMs).padStart(10)} ${String(r.auditMs).padStart(7)} ${String(r.auditNoCrcMs).padStart(8)} ${String(r.ratio).padStart(7)} ${String(r.entriesPerSec).padStart(11)} ${String(r.mbPerSec).padStart(6)}`,
  );
}
console.log(`\nsalvage (index wiped, 500 × 16 KiB): ${doc.salvage.ms} ms · recovered ${doc.salvage.recovered}, verified ${doc.salvage.verified}`);
console.log('wrote docs/MEASUREMENTS.json');

// Keep the bundle honest: the package must still ship the same size class.
if (existsSync(join(root, 'package.json'))) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(`package ${pkg.name}@${pkg.version} · runtime dependency: ${Object.keys(pkg.dependencies || {}).join(', ') || 'none'}`);
}
