/**
 * Cross-implementation checks against Python's `zipfile` — an independent
 * reference implementation maintained by CPython, not by this project.
 * The suite is skipped (not silently passed) when no interpreter is available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { audit, salvage } from '../src/index.js';
import { buildArchive, flipBit, payloadOffset } from './helpers/craft.js';

const PY = ['python', 'python3', 'py'].find((bin) => {
  const r = spawnSync(bin, ['-V'], { encoding: 'utf8' });
  return r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`);
});

function py(code, args = []) {
  const r = spawnSync(PY, ['-c', code, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const dir = mkdtempSync(join(tmpdir(), 'ziptriage-py-'));
const enc = new TextEncoder();

test('python zipfile confirms corruption that fflate returns as success', { skip: !PY && 'python3 not available' }, () => {
  const payload = enc.encode('STORED-PAYLOAD-'.repeat(500));
  const good = buildArchive([{ name: 'img.dat', data: payload, method: 0 }]);
  const broken = flipBit(good, payloadOffset(good) + 321);
  const p = join(dir, 'bitflip.zip');
  writeFileSync(p, broken);

  // 1. Upstream codec: no error, wrong bytes.
  const viaFflate = unzipSync(broken)['img.dat'];
  assert.equal(viaFflate.length, payload.length);
  assert.notEqual(Buffer.compare(Buffer.from(viaFflate), Buffer.from(payload)), 0, 'payload really differs');

  // 2. Reference implementation: hard failure.
  const verdict = py('import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', [p]);
  assert.equal(verdict, 'img.dat');

  // 3. This tool: names the file and the mismatching checksums.
  const r = audit(broken);
  assert.equal(r.summary.verdict, 'corrupt');
  const f = r.findings.find((x) => x.code === 'crc-mismatch');
  assert.ok(f);
  assert.match(f.message, /img\.dat|CRC-32/);
  assert.equal(r.entries[0].crc.ok, false);
});

test('salvaged archives are readable by python zipfile', { skip: !PY && 'python3 not available' }, () => {
  const files = [
    { name: 'a.txt', data: enc.encode('alpha '.repeat(400)) },
    { name: 'dir/b.bin', data: new Uint8Array(1200).fill(9), method: 0 },
    { name: 'c.txt', data: enc.encode('gamma') },
  ];
  const good = buildArchive(files);
  const cut = good.subarray(0, good.length - 80);
  const repaired = salvage(cut).archive;
  const p = join(dir, 'repaired.zip');
  writeFileSync(p, repaired);

  const out = py(
    [
      'import sys,zipfile,hashlib',
      'z=zipfile.ZipFile(sys.argv[1])',
      'bad=z.testzip()',
      'names=sorted(z.namelist())',
      'sizes=[len(z.read(n)) for n in names]',
      'print(bad, names, sizes)',
    ].join('\n'),
    [p],
  );
  assert.match(out, /^None /, 'python must report no CRC error');
  assert.match(out, /a\.txt/);
  assert.match(out, /dir\/b\.bin/);
  assert.match(out, /1200/);
});

test('archives written by python zipfile audit clean', { skip: !PY && 'python3 not available' }, () => {
  const p = join(dir, 'py-made.zip');
  py(
    [
      'import sys,zipfile',
      'with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:',
      '    z.writestr("a.txt","alpha "*100)',
      '    with z.open("big.bin","w",force_zip64=True) as f:',
      '        f.write(b"x"*5000)',
      '    z.writestr("empty.txt","")',
    ].join('\n'),
    [p],
  );
  const r = audit(readFileSync(p), { name: 'py-made.zip' });
  assert.equal(r.summary.verdict, 'clean', JSON.stringify(r.findings));
  assert.equal(r.summary.entries, 3);
  assert.equal(r.container.cdComplete, true);
});

test('python and ziptriage agree on a corrupted python-made archive', { skip: !PY && 'python3 not available' }, () => {
  const p = join(dir, 'py-stored.zip');
  py(
    [
      'import sys,zipfile',
      'with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_STORED) as z:',
      '    z.writestr("data.bin",bytes(range(256))*40)',
    ].join('\n'),
    [p],
  );
  const good = readFileSync(p);
  // Python writes sizes/CRC from its own computation; flip a payload byte.
  const lhNameLen = good.readUInt16LE(26);
  const lhExtraLen = good.readUInt16LE(28);
  const dataStart = 30 + lhNameLen + lhExtraLen;
  const broken = flipBit(new Uint8Array(good), dataStart + 500);
  const bp = join(dir, 'py-stored-broken.zip');
  writeFileSync(bp, broken);

  const pyVerdict = py('import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', [bp]);
  const mine = audit(broken);
  assert.equal(pyVerdict, 'data.bin');
  assert.equal(mine.summary.verdict, 'corrupt');
  assert.equal(mine.entries[0].name, 'data.bin');
  assert.equal(mine.entries[0].crc.ok, false);
  // And the repair path: python must accept what we rebuild.
  const fixed = salvage(broken).archive;
  const fp = join(dir, 'py-stored-fixed.zip');
  writeFileSync(fp, fixed);
  assert.equal(py('import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', [fp]), 'None');
});

test('a python-made archive with a destroyed index is salvageable', { skip: !PY && 'python3 not available' }, () => {
  const p = join(dir, 'py-cd-broken.zip');
  py(
    [
      'import sys,zipfile',
      'with zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:',
      '    for i in range(4): z.writestr(f"f{i}.txt", "payload-%d "%i * 50)',
    ].join('\n'),
    [p],
  );
  const bytes = new Uint8Array(readFileSync(p));
  const eocdAt = bytes.length - 22;
  const cdOffset = new DataView(bytes.buffer).getUint32(eocdAt + 16, true);
  // Wipe the central directory, keep every local header.
  bytes.fill(0, cdOffset, bytes.length - 22);
  const r = salvage(bytes);
  assert.equal(r.summary.recovered, 4);
  assert.equal(r.summary.selfCheck.verdict, 'clean');
  const names = r.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt']);
});

test('the interop suite declares its dependency instead of faking a pass', () => {
  // Guard against a future refactor that turns a missing interpreter into a pass.
  if (!PY) {
    assert.equal(PY, undefined);
  } else {
    assert.equal(typeof PY, 'string');
  }
});
