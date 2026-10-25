import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/index.js';
import { buildArchive } from './helpers/craft.js';

// import.meta.dirname only exists from Node 20.11; this package claims >=18.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'ziptriage.js');
const dir = mkdtempSync(join(tmpdir(), 'ziptriage-cli-'));
const enc = new TextEncoder();

const good = buildArchive([
  { name: 'a.txt', data: enc.encode('alpha '.repeat(300)) },
  { name: 'b.bin', data: new Uint8Array(500).fill(3), method: 0 },
]);
const goodPath = join(dir, 'good.zip');
writeFileSync(goodPath, good);

const broken = buildArchive([
  { name: 'a.txt', data: enc.encode('alpha '.repeat(300)) },
  { name: 'b.bin', data: new Uint8Array(500).fill(3), method: 0 },
], { corruptCd: true });
const brokenPath = join(dir, 'broken.zip');
writeFileSync(brokenPath, broken);

function run(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    timeout: 30000,
  });
}

test('audit exits 0 on a clean archive', () => {
  const r = run(['audit', goodPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CLEAN/);
  assert.match(r.stdout, /2\/2 entries verified/);
});

test('audit exits 4 and explains the corruption', () => {
  const r = run(['audit', brokenPath]);
  assert.equal(r.status, 5, 'a destroyed index is unreadable, not merely corrupt');
  assert.match(r.stdout, /UNREADABLE/);
  assert.match(r.stdout, /scan-recoverable|cd-signature-invalid/);
});

test('audit --json is parseable and carries the exit code', () => {
  const r = run(['audit', goodPath, '--json']);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.summary.verdict, 'clean');
  assert.equal(report.file.sha256.length, 64);
  assert.equal(report.entries.length, 2);
});

test('audit reads from stdin', () => {
  const r = run(['audit', '-', '--json'], good);
  assert.equal(r.status, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.file.name, 'stdin');
  assert.equal(report.summary.entries, 2);
});

test('audit --no-crc skips checksum verification but keeps structure', () => {
  // CRC wrong in BOTH headers, so the only finding is the checksum itself.
  const badCrc = buildArchive([{ name: 'a.txt', data: 'x', crc: 1 }]);
  const p = join(dir, 'badcrc.zip');
  writeFileSync(p, badCrc);
  assert.equal(run(['audit', p]).status, 4);
  assert.equal(run(['audit', p, '--no-crc']).status, 0);
});

test('salvage writes a repaired archive that audits clean', () => {
  const out = join(dir, 'repaired.zip');
  const r = run(['salvage', brokenPath, '-o', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(out));
  const re = audit(readFileSync(out));
  assert.equal(re.summary.verdict, 'clean');
  assert.equal(re.summary.entries, 2);
  assert.match(r.stdout, /recovered 2 entries/);
});

test('salvage --extract writes files with sanitised names', () => {
  const evil = buildArchive([{ name: '../../escape.txt', data: 'nope' }], { corruptCd: true });
  const p = join(dir, 'evil.zip');
  writeFileSync(p, evil);
  const outDir = join(dir, 'out');
  const r = run(['salvage', p, '-o', join(dir, 'evil-fixed.zip'), '--extract', outDir, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(outDir);
  assert.deepEqual(files, ['escape.txt']);
  assert.equal(readFileSync(join(outDir, 'escape.txt'), 'utf8'), 'nope');
});

test('salvage of unrecoverable bytes exits 5', () => {
  const junkPath = join(dir, 'junk.bin');
  writeFileSync(junkPath, Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 17) & 0xff)));
  const r = run(['salvage', junkPath, '-o', join(dir, 'junk-out.zip')]);
  assert.equal(r.status, 5);
});

test('usage errors exit 2', () => {
  assert.equal(run(['audit']).status, 2);
  assert.equal(run(['frobnicate', goodPath]).status, 2);
  assert.equal(run(['audit', goodPath, '--bogus']).status, 2);
  assert.equal(run(['audit', join(dir, 'missing.zip')]).status, 2);
});

test('--version and --help work without a subcommand', () => {
  const v = run(['--version']);
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const h = run(['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /退出码/);
});
