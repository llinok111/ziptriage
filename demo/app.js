/**
 * Demo front-end: same container layer as the CLI, no build step, no network.
 * Files never leave the browser — all work happens on an in-memory Uint8Array.
 */
import { fromGlobal } from '../src/browser.js';
import { findEocd, parseLocalHeader } from '../src/core/parse.js';
import { u32 } from '../src/core/bytes.js';
import { buildZip } from '../src/core/writer.js';

const api = fromGlobal(window.fflate);
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

$('version').textContent = api.version;
$('engine').textContent = `fflate ${window.fflate ? 'umd' : '?'} · ${api.codec ? 'codec ready' : 'codec missing'}`;

let current = null; // {name, bytes, report}

/* ---------- samples ---------- */

function sampleBytes(kind) {
  const files = [
    { name: 'docs/readme.txt', data: enc.encode('release notes\n'.repeat(400)) },
    { name: 'assets/photo.dat', data: new Uint8Array(6000).fill(0x5a), method: 0 },
    { name: 'assets/empty.txt', data: new Uint8Array(0) },
  ];
  const zip = buildZip(files, { codec: api.codec });
  if (kind === 'healthy') return zip;

  if (kind === 'bitflip') {
    const copy = zip.slice();
    const second = findEntryOffset(copy, 1);
    const lh = parseLocalHeader(copy, second);
    copy[lh.dataOffset + 1234] ^= 0x01;
    return copy;
  }
  if (kind === 'truncated') return zip.slice(0, zip.length - 90);

  if (kind === 'destroyed') {
    const copy = zip.slice();
    const eocd = findEocd(copy);
    copy.fill(0, eocd.cdOffset, eocd.offset);
    return copy;
  }
  return zip;
}

/** Walk local headers to find the N-th entry (demo-only helper). */
function findEntryOffset(bytes, n) {
  let at = 0;
  let seen = 0;
  while (at + 4 <= bytes.length) {
    if (u32(bytes, at) === 0x04034b50) {
      if (seen === n) return at;
      const lh = parseLocalHeader(bytes, at);
      if (!lh) break;
      const usesDescriptor = (lh.flags & 0x8) !== 0;
      at = lh.dataOffset + (usesDescriptor ? 0 : lh.compressedSize);
      seen++;
      continue;
    }
    at++;
  }
  return 0;
}

/* ---------- rendering ---------- */

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

const STATUS_TEXT = { verified: '✓ 通过', warning: '! 告警', error: '✗ 损坏', unverifiable: '? 无法验证' };
const STATUS_CLASS = { verified: 'ok', warning: 'warn', error: 'bad', unverifiable: 'unverifiable' };

function render(report, name) {
  $('errorPanel').classList.add('hidden');
  $('result').classList.remove('hidden');

  const pill = $('verdict');
  pill.textContent = report.summary.verdict.toUpperCase();
  pill.className = `pill ${report.summary.verdict}`;

  const s = report.summary;
  $('stats').textContent =
    `${s.verified}/${s.entries} 条通过 · ${bytes(s.decodedBytes)} 已解码 · ${s.errors + s.critical} 错误 / ${s.warnings} 告警 · ${s.durationMs} ms`;

  const c = report.container;
  $('container').textContent =
    `${name} · ${bytes(report.file.size)} · ` +
    (c.eocd ? `EOCD@${c.eocd.offset} · zip64 ${c.eocd.zip64 ? 'yes' : 'no'} · ` : 'no EOCD · ') +
    `${c.entriesDeclared ?? '?'} declared / ${c.entriesParsed} parsed · index ${c.cdComplete ? 'complete' : 'BROKEN'}` +
    (c.entriesScanned ? ` · ${c.entriesScanned} 条可由扫描恢复` : '');

  const tbody = $('entries').querySelector('tbody');
  tbody.replaceChildren();
  for (const e of report.entries) {
    const tr = document.createElement('tr');
    const crc = e.crc.ok === true ? 'ok' : e.crc.ok === false ? `✗ ${hex(e.crc.expected)} ≠ ${hex(e.crc.actual)}` : '未校验';
    tr.innerHTML =
      `<td class="st ${STATUS_CLASS[e.status]}">${STATUS_TEXT[e.status]}</td>` +
      `<td class="name">${esc(e.name)}</td>` +
      `<td>${esc(e.methodName)}</td>` +
      `<td class="num">${bytes(e.sizes.uncompressedDeclared)}</td>` +
      `<td class="num">${e.sizes.uncompressedActual == null ? '—' : bytes(e.sizes.uncompressedActual)}</td>` +
      `<td class="crc ${e.crc.ok === false ? 'bad' : ''}">${crc}</td>`;
    tbody.append(tr);
  }
  $('entryCount').textContent = `${report.entries.length} 条`;

  const findings = $('findings');
  findings.replaceChildren();
  // Show every finding: the most actionable one ("scan-recoverable") is an info,
  // so filtering info would hide the recovery hint exactly when it matters.
  // Noise is controlled by grouping identical codes, not by dropping levels.
  const shown = report.findings;
  // Collapse identical codes so a 500-entry archive does not print 500 lines.
  const grouped = new Map();
  for (const f of shown) {
    const key = `${f.severity}|${f.code}`;
    if (!grouped.has(key)) grouped.set(key, { ...f, count: 0, entries: [] });
    const g = grouped.get(key);
    g.count++;
    if (f.entry != null && g.entries.length < 5) g.entries.push(f.entry);
  }
  const ORDER = { critical: 0, error: 1, warning: 2, info: 3 };
  for (const g of [...grouped.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity])) {
    const li = document.createElement('li');
    li.className = g.severity;
    const where = g.entries.length ? ` <span class="crc">[entry ${g.entries.join(', ')}${g.count > g.entries.length ? ', …' : ''}]</span>` : '';
    li.innerHTML = `<code>${esc(g.code)}</code> ×${g.count} — ${esc(g.message)}${where}`;
    findings.append(li);
  }
  $('findingCount').textContent = `${shown.length} 项 / ${grouped.size} 类`;

  $('download').classList.add('hidden');
  $('salvageOut').classList.add('hidden');
  $('salvage').classList.remove('hidden');
  $('salvage').textContent = '打捞可恢复内容';
}

function hex(n) {
  return n == null ? '--------' : (n >>> 0).toString(16).padStart(8, '0');
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- actions ---------- */

function auditBytes(bytesIn, name) {
  if (!bytesIn || !bytesIn.length) return;
  try {
    const report = api.audit(bytesIn, { name });
    current = { name, bytes: bytesIn, report };
    render(report, name);
  } catch (err) {
    $('result').classList.add('hidden');
    $('errorPanel').classList.remove('hidden');
    $('errorText').textContent = `审计器抛出异常：${err.message}`;
  }
}

async function loadFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  auditBytes(buf, file.name);
}

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
});

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

for (const btn of document.querySelectorAll('[data-sample]')) {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.sample;
    const names = { healthy: 'sample-healthy.zip', bitflip: 'sample-bitflip.zip', truncated: 'sample-truncated.zip', destroyed: 'sample-cd-destroyed.zip' };
    auditBytes(sampleBytes(kind), names[kind] || 'sample.zip');
  });
}

$('salvage').addEventListener('click', () => {
  if (!current) return;
  const result = api.salvage(current.bytes, { name: current.name });
  const s = result.summary;
  const lines = [
    `恢复 ${s.recovered} 条（${bytes(s.bytes)}）· 完整 ${s.verified} / 部分 ${s.partial} · 放弃 ${s.dropped}`,
  ];
  if (result.renamed.length) lines.push(`重命名 ${result.renamed.length} 条：${result.renamed.map((r) => `${r.from} → ${r.to}`).join('，')}`);
  for (const d of result.dropped.slice(0, 6)) lines.push(`✗ ${d.name}：${d.reason}`);
  if (s.selfCheck) lines.push(`修复包自检：${s.selfCheck.entries} 条 · ${s.selfCheck.verdict.toUpperCase()} · ${bytes(s.outBytes)}`);
  const out = $('salvageOut');
  out.textContent = lines.join('\n');
  out.classList.remove('hidden');

  if (result.archive) {
    const blob = new Blob([result.archive], { type: 'application/zip' });
    const a = $('download');
    if (a.dataset.url) URL.revokeObjectURL(a.dataset.url);
    a.href = URL.createObjectURL(blob);
    a.dataset.url = a.href;
    a.download = current.name.replace(/\.zip$/i, '') + '.repaired.zip';
    a.classList.remove('hidden');
  }
});

$('downloadJson').addEventListener('click', () => {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current.report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = current.name.replace(/\.zip$/i, '') + '.report.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

// Auto-run one sample so the page is never blank when served for a review.
auditBytes(sampleBytes('healthy'), 'sample-healthy.zip');
