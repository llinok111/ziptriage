/** Human and machine output. JSON output is deterministic: no timestamps, no paths. */
const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

function paint(on, code, s) {
  return on ? `${code}${s}${C.reset}` : s;
}

const MARK = { verified: '✓', warning: '!', error: '✗', unverifiable: '?' };

function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function pad(s, w) {
  // Width-aware enough for the ASCII/CJK mix used in file names.
  let width = 0;
  for (const ch of s) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, w - width));
}

/**
 * @param {ReturnType<import('./audit.js').auditArchive>} report
 * @param {{color?:boolean, maxEntries?:number}} [opts]
 */
export function formatAudit(report, opts = {}) {
  const color = !!opts.color;
  const maxEntries = opts.maxEntries ?? 200;
  const lines = [];
  const s = report.summary;
  const verdictColor = s.verdict === 'clean' ? C.green : s.verdict === 'warnings' ? C.yellow : C.red;
  lines.push(
    `${paint(color, C.cyan, 'ziptriage')} ${report.version} · ${report.file.name || 'archive'} (${bytes(report.file.size)})`,
  );
  const c = report.container;
  lines.push(
    paint(
      color,
      C.dim,
      `container: ${c.eocd ? `EOCD@${c.eocd.offset}` : 'no EOCD'} · zip64 ${c.eocd && c.eocd.zip64 ? 'yes' : 'no'} · ` +
        `${c.entriesDeclared ?? '?'} declared / ${c.entriesParsed} parsed · index ${c.cdComplete ? 'complete' : 'BROKEN'}` +
        (c.prefixStub ? ` · ${c.prefixStub}B prefix` : ''),
    ),
  );

  if (report.entries.length) {
    lines.push('');
    const names = report.entries.slice(0, maxEntries);
    const wName = Math.min(52, Math.max(4, ...names.map((e) => pad(e.name, 0).length)));
    for (const e of names) {
      const mark = e.status === 'verified' ? '✓' : e.status === 'warning' ? '!' : e.status === 'unverifiable' ? '?' : '✗';
      const tone = e.status === 'verified' ? C.green : e.status === 'warning' ? C.yellow : e.status === 'unverifiable' ? C.cyan : C.red;
      const crc = e.crc.ok === true ? 'crc ok' : e.crc.ok === false ? `crc ${hex8(e.crc.expected)} ≠ ${hex8(e.crc.actual)}` : 'crc n/a';
      lines.push(
        `  ${paint(color, tone, mark)} ${pad(e.name.length > 52 ? `${e.name.slice(0, 49)}...` : e.name, wName)}  ` +
          `${pad(e.methodName, 16)} ${pad(bytes(e.sizes.uncompressedDeclared), 10)} ${crc}`,
      );
    }
    if (report.entries.length > maxEntries) {
      lines.push(paint(color, C.dim, `  … ${report.entries.length - maxEntries} more entries (use --json for the full list)`));
    }
  }

  const actionable = report.findings.filter((f) => f.severity !== 'info');
  if (actionable.length) {
    lines.push('');
    lines.push('findings:');
    const grouped = new Map();
    for (const f of actionable) {
      const key = `${f.severity}:${f.code}`;
      grouped.set(key, [...(grouped.get(key) || []), f]);
    }
    for (const [key, group] of grouped) {
      const [sev] = key.split(':');
      const tone = sev === 'critical' || sev === 'error' ? C.red : sev === 'warning' ? C.yellow : C.cyan;
      const where = group[0].entry != null ? ` [entry ${group.slice(0, 3).map((g) => g.entry).join(',')}${group.length > 3 ? ',…' : ''}]` : '';
      lines.push(`  ${paint(color, tone, group[0].code)} ×${group.length}${where} — ${group[0].message}`);
    }
  }

  lines.push('');
  lines.push(
    `${paint(color, verdictColor, s.verdict.toUpperCase())} · ${s.verified}/${s.entries} entries verified · ` +
      `${s.errors} error(s), ${s.warnings} warning(s), ${s.critical} critical · exit ${s.exitCode} · ${s.durationMs} ms`,
  );
  return lines.join('\n');
}

function hex8(n) {
  return n == null ? '--------' : (n >>> 0).toString(16).padStart(8, '0');
}

/** @param {ReturnType<import('./salvage.js').salvageArchive>} result */
export function formatSalvage(result, opts = {}) {
  const color = !!opts.color;
  const lines = [];
  const s = result.summary;
  lines.push(`${paint(color, C.cyan, 'ziptriage salvage')} · recovered ${s.recovered} entr${s.recovered === 1 ? 'y' : 'ies'} (${bytes(s.bytes)})`);
  lines.push(
    paint(color, C.dim, `source verdict ${result.source.verdict} · index ${result.source.cdComplete ? 'usable' : 'BROKEN'} · ` +
      `${result.source.entriesIndexed} indexed + ${result.source.entriesFromScanOnly} found by header scan`),
  );
  for (const r of result.recovered.slice(0, 100)) {
    const tone = r.grade === 'verified' ? C.green : C.yellow;
    lines.push(`  ${paint(color, tone, r.grade === 'verified' ? '✓' : '~')} ${pad(r.repackedName || r.name, 46)} ${pad(bytes(r.bytes), 10)} ${r.grade}`);
  }
  if (result.renamed && result.renamed.length) {
    lines.push('');
    lines.push(paint(color, C.cyan, 'renamed on repack (unsafe or duplicate path):'));
    for (const r of result.renamed.slice(0, 10)) lines.push(`  - ${r.from} → ${r.to}`);
  }
  if (result.dropped.length) {
    lines.push('');
    lines.push(paint(color, C.yellow, 'not recovered:'));
    for (const d of result.dropped.slice(0, 20)) lines.push(`  - ${d.name}: ${d.reason}`);
    if (result.dropped.length > 20) lines.push(paint(color, C.dim, `  … ${result.dropped.length - 20} more`));
  }
  if (s.selfCheck) {
    lines.push('');
    lines.push(
      `repaired archive: ${bytes(s.outBytes)} · ${s.selfCheck.entries} entries · re-audit ${s.selfCheck.verdict.toUpperCase()} (${s.selfCheck.verified} verified)`,
    );
  }
  return lines.join('\n');
}
