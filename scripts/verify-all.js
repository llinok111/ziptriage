#!/usr/bin/env node
/**
 * One-shot acceptance gate. Runs everything a reviewer would run and refuses to
 * print "ok" unless every step produced a real artefact / a real exit code.
 *
 * Counting is explicit: executed / skipped / failed are reported separately, and
 * a skipped step never counts as passed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, salvage } from '../src/index.js';
import { buildArchive, flipBit, payloadOffset } from '../test/helpers/craft.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const enc = new TextEncoder();
let executed = 0;
let skipped = 0;
let failed = 0;
const lines = [];

function step(name, fn, { optional = false } = {}) {
  const t = Date.now();
  try {
    const detail = fn();
    executed++;
    lines.push(`  ok   ${name} (${Date.now() - t} ms)${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    if (optional && e && e.skip) {
      skipped++;
      lines.push(`  skip ${name} — ${e.message}`);
    } else {
      failed++;
      lines.push(`  FAIL ${name} — ${e && e.message}`);
    }
  }
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function runNode(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 180000, ...opts });
}

lines.push('ziptriage acceptance\n');

step('test suite (node --test)', () => {
  const r = runNode(['--test', 'test/crc32.test.js', 'test/parse.test.js', 'test/audit.test.js', 'test/salvage.test.js', 'test/writer.test.js', 'test/cli.test.js', 'test/interop.test.js']);
  must(r.status === 0, `exit ${r.status}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-800)}`);
  const pass = /# pass (\d+)/.exec(r.stdout);
  const fail = /# fail (\d+)/.exec(r.stdout);
  const skip = /# skipped (\d+)/.exec(r.stdout);
  must(fail && fail[1] === '0', `failures reported: ${fail && fail[1]}`);
  must(pass && Number(pass[1]) > 0, 'no tests executed');
  return `${pass[1]} pass / ${fail[1]} fail / ${skip ? skip[1] : 0} skipped`;
});

step('upstream baseline reproducible', () => {
  const before = existsSync(join(root, 'docs', 'BASELINE.json')) ? readFileSync(join(root, 'docs', 'BASELINE.json'), 'utf8') : null;
  const r = runNode(['scripts/baseline-upstream.js']);
  must(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const after = readFileSync(join(root, 'docs', 'BASELINE.json'), 'utf8');
  const doc = JSON.parse(after);
  must(doc.cases.length === 6, `expected 6 cases, got ${doc.cases.length}`);
  const stored = doc.cases.find((c) => c.id === 'stored-bitflip');
  must(stored.upstream.threw === false && stored.upstream.differingBytes === 1, 'upstream silently returned corrupt bytes');
  must(stored.ziptriage.verdict === 'corrupt', 'triage failed to flag the same file');
  return before === after ? '6 cases, byte-identical to previous run' : '6 cases (regenerated)';
});

step('demo assets present and offline', () => {
  const vendor = join(root, 'demo', 'vendor', 'fflate.umd.js');
  must(existsSync(vendor), 'demo/vendor/fflate.umd.js missing — run npm run demo');
  must(statSync(vendor).size > 10000, 'vendor copy too small');
  const html = readFileSync(join(root, 'demo', 'index.html'), 'utf8');
  must(!/https?:\/\/[^"']+\.(js|css)/.test(html), 'demo references a remote asset');
  return `${(statSync(vendor).size / 1024).toFixed(1)} KB vendored`;
});

step('CLI end-to-end on a broken archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ziptriage-accept-'));
  const broken = buildArchive([
    { name: 'keep.txt', data: enc.encode('keep me '.repeat(200)) },
    { name: 'bad.bin', data: new Uint8Array(2000).fill(5), method: 0 },
  ], { corruptCd: true });
  const p = join(dir, 'broken.zip');
  writeFileSync(p, broken);
  const a = runNode(['bin/ziptriage.js', 'audit', p]);
  must(a.status === 5, `audit exit ${a.status}, expected 5`);
  const out = join(dir, 'fixed.zip');
  const s = runNode(['bin/ziptriage.js', 'salvage', p, '-o', out]);
  must(s.status === 0, `salvage exit ${s.status}: ${s.stdout}${s.stderr}`);
  must(existsSync(out), 'repaired archive not written');
  const re = audit(readFileSync(out));
  must(re.summary.verdict === 'clean', `repaired archive verdict ${re.summary.verdict}`);
  must(re.summary.entries === 2, `repaired entries ${re.summary.entries}`);
  return 'audit=5 → salvage=0 → re-audit=clean, 2/2 entries';
});

step('library API contract', () => {
  const zip = buildArchive([{ name: 'a.txt', data: 'x' }]);
  const r = audit(zip);
  must(r.summary.verdict === 'clean' && r.summary.exitCode === 0, 'clean contract');
  must(typeof r.entries[0].crc.actual === 'number', 'crc not computed');

  const stored = buildArchive([{ name: 'b.bin', data: new Uint8Array(400).fill(1), method: 0 }]);
  const damaged = flipBit(stored, payloadOffset(stored) + 10);
  const d = audit(damaged);
  must(d.summary.verdict === 'corrupt', 'damage not detected via library API');
  must(d.entries[0].crc.ok === false, 'crc.ok not false on damaged payload');
  must(d.entries[0].status === 'error', 'entry status not demoted');
  return 'clean=0, damaged=corrupt with crc.ok=false';
});

step('salvage is deterministic', () => {
  const broken = buildArchive([
    { name: 'a.txt', data: 'alpha' },
    { name: 'b.txt', data: 'beta' },
  ], { corruptCd: true });
  const a = salvage(broken).archive;
  const b = salvage(broken).archive;
  must(Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, 'two runs differ');
  return `${a.length} bytes, identical across runs`;
});

step('python zipfile interop', () => {
  const py = ['python', 'python3', 'py'].find((bin) => spawnSync(bin, ['-V'], { encoding: 'utf8' }).status === 0);
  if (!py) {
    const e = new Error('no python3 on PATH');
    e.skip = true;
    throw e;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ziptriage-py-'));
  const broken = buildArchive([{ name: 'img.dat', data: new Uint8Array(1000).fill(9), method: 0 }]);
  const bad = flipBit(broken, payloadOffset(broken) + 10);
  const p = join(dir, 'bad.zip');
  writeFileSync(p, bad);
  const out = spawnSync(py, ['-c', 'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', p], { encoding: 'utf8' });
  must(out.status === 0, out.stderr);
  must(out.stdout.trim() === 'img.dat', `python said "${out.stdout.trim()}"`);
  const fixed = salvage(bad).archive;
  const fp = join(dir, 'fixed.zip');
  writeFileSync(fp, fixed);
  const out2 = spawnSync(py, ['-c', 'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', fp], { encoding: 'utf8' });
  must(out2.stdout.trim() === 'None', `python rejected the repair: ${out2.stdout}`);
  return 'python flags the damage; python accepts the repair';
});

step('benchmark produces numbers', () => {
  const r = runNode(['bench/bench.js']);
  must(r.status === 0, `exit ${r.status}: ${r.stderr}`);
  const doc = JSON.parse(readFileSync(join(root, 'docs', 'MEASUREMENTS.json'), 'utf8'));
  must(doc.rows.length >= 2, 'no rows');
  must(doc.salvage.recovered > 0, 'salvage measured nothing');
  return `${doc.rows[0].entriesPerSec} entries/s, ${doc.rows[0].mbPerSec} MB/s, salvage ${doc.salvage.ms} ms`;
});

step('licence and provenance files', () => {
  const lic = readFileSync(join(root, 'LICENSE'), 'utf8');
  must(/^MIT License/m.test(lic), 'LICENSE is not plain MIT (GitHub would show "Other")');
  must(lic.split('\n').filter((l) => l.trim()).length <= 22, 'LICENSE has extra content appended');
  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  must(/fflate 0\.8\.3/.test(notice), 'NOTICE does not name the upstream version');
  must(/Arjun Barrett/.test(notice), 'NOTICE missing upstream copyright');
  must(/No changes were made/.test(notice), 'NOTICE does not state the modification status');
  return 'MIT text clean, upstream attributed with version + copyright';
});

step('package metadata matches the code', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  must(pkg.bin && pkg.bin.ziptriage === './bin/ziptriage.js', 'bin entry wrong');
  must(existsSync(join(root, 'bin', 'ziptriage.js')), 'bin file missing');
  must(pkg.main === './src/index.js', 'main entry wrong');
  must(existsSync(join(root, 'src', 'index.js')), 'main file missing');
  for (const p of pkg.files) must(existsSync(join(root, p)), `files[] entry missing: ${p}`);
  must(pkg.dependencies && pkg.dependencies.fflate, 'fflate dependency missing');
  const v = runNode(['bin/ziptriage.js', '--version']).stdout.trim();
  must(v === pkg.version, `--version ${v} != package ${pkg.version}`);
  return `${pkg.name}@${pkg.version}, ${pkg.files.length} packaged paths, bin+main resolve`;
});

step('README claims are shaped correctly (not gated on absolute speed)', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const meas = JSON.parse(readFileSync(join(root, 'docs', 'MEASUREMENTS.json'), 'utf8'));

  // Lesson burned twice already: absolute throughput and the audit/unzipSync
  // ratio are machine- and load-dependent (Windows 3.26-3.52x, ubuntu 4.45x; the
  // same corpus measured 21k/s idle and 5.6k/s under load). A gate that compares
  // a measured value against a published number is therefore a false-failure
  // generator. What CAN be checked is the *shape* of the claim: it must be a
  // range, never a point estimate, and the report must record how it was made.
  const eps = /([\d,]{3,})[–-]([\d,]{3,})\s*条\/秒/.exec(readme);
  must(eps, 'README must publish a throughput RANGE ("N–N 条/秒"), not a point estimate');
  const lo = Number(eps[1].replace(/,/g, ''));
  const hi = Number(eps[2].replace(/,/g, ''));
  must(lo < hi, `throughput range is inverted: ${lo}-${hi}`);

  const ratio = /(\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)\s*倍/.exec(readme);
  must(ratio, 'README must publish a ratio RANGE ("N–N 倍"), not a point estimate');
  must(Number(ratio[1]) < Number(ratio[2]), 'ratio range is inverted');

  must(meas.runs >= 3, 'measurements must come from repeated runs');
  must(meas.rows.length >= 2, 'measurements must cover at least two corpus sizes');
  for (const r of meas.rows) {
    must(r.unzipSyncMs > 0 && r.auditMs > 0, 'measurements contain empty timing');
    must(r.entries > 0, 'measurements contain an empty corpus');
  }

  const testCount = [...readme.matchAll(/(\d{2,3})\s*项/g)].map((m) => Number(m[1]));
  const suite = runNode(['--test', 'test/crc32.test.js', 'test/parse.test.js', 'test/audit.test.js', 'test/salvage.test.js', 'test/writer.test.js', 'test/cli.test.js', 'test/interop.test.js']);
  const pass = Number((/# pass (\d+)/.exec(suite.stdout) || [0, 0])[1]);
  must(testCount.some((n) => n === pass), `README test count ${testCount.join('/')} vs actual ${pass}`);

  const now = meas.rows[0];
  return `${pass} tests; claims ${lo}-${hi}/s and ${ratio[1]}-${ratio[2]}x; this run measured ${now.entriesPerSec}/s, ${now.ratio}x (advisory, not gated)`;
});

const total = executed + skipped + failed;
console.log(lines.join('\n'));
console.log(`\nexecuted ${executed} · skipped ${skipped} · failed ${failed} (of ${total})`);
if (failed > 0) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
}
if (skipped > 0) {
  console.log('\nRESULT: PASS WITH SKIPS — skipped steps are NOT verified');
  process.exit(0);
}
console.log('\nRESULT: PASS');
