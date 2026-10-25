/**
 * Container audit: cross-checks central directory, local headers and the actual
 * byte stream, then verifies CRC-32 of every decodable entry.
 *
 * Upstream fflate walks the central directory and calls inflateSync(); it never
 * compares the result against the stored CRC, so a flipped bit inside a STORED
 * entry (or a deflate stream that still decodes) is returned as success.
 * See docs/UPSTREAM.md for the measured baseline.
 */
import { crc32 } from './crc32.js';
import { METHOD, FLAG, SIG_LOCAL, u32 } from './bytes.js';
import { findEocd, parseCentralDirectory, parseLocalHeader } from './parse.js';
import { scanLocalHeaders } from './scan.js';

export const DEFAULTS = {
  maxEntryBytes: 256 * 1024 * 1024, // per-entry declared uncompressed ceiling
  maxTotalBytes: 1024 * 1024 * 1024, // whole-archive decompressed budget
  maxRatio: 500, // compressed -> uncompressed expansion ceiling
  verifyCrc: true,
  crossCheckLocalHeaders: true,
  returnData: false,
};

const SEVERITY_RANK = { info: 0, warning: 1, error: 2, critical: 3 };

function finding(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

function worst(a, b) {
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b;
}

function describeMethod(m) {
  if (m === METHOD.STORED) return 'stored';
  if (m === METHOD.DEFLATE) return 'deflate';
  const names = { 1: 'shrink', 6: 'implode', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 99: 'aes' };
  return names[m] ? `${names[m]} (${m})` : `method ${m}`;
}

/**
 * Decode one entry's payload under explicit memory limits.
 * @returns {{ok:boolean, data?:Uint8Array, error?:string, code?:string, truncated?:boolean}}
 */
export function decodeEntry(u8, entry, localHeader, codec, limits) {
  const start = localHeader.dataOffset;
  const declaredCompressed = entry.compressedSize;
  const end = start + declaredCompressed;
  const availableEnd = Math.min(end, u8.length);
  const truncated = availableEnd < end;
  if (start > u8.length) {
    return { ok: false, code: 'data-out-of-range', error: 'entry data starts past end of file' };
  }
  const payload = u8.subarray(start, availableEnd);

  if (entry.uncompressedSize > limits.maxEntryBytes) {
    return {
      ok: false,
      code: 'expansion-limit',
      error: `declared uncompressed size ${entry.uncompressedSize} exceeds the ${limits.maxEntryBytes}-byte ceiling`,
    };
  }

  try {
    if (entry.method === METHOD.STORED) {
      return { ok: true, data: payload, truncated };
    }
    if (entry.method === METHOD.DEFLATE) {
      const out = codec.inflateSync(payload, { out: new Uint8Array(Math.min(entry.uncompressedSize, limits.maxEntryBytes)) });
      return { ok: true, data: out, truncated };
    }
  } catch (e) {
    return {
      ok: false,
      code: truncated ? 'data-out-of-range' : 'deflate-error',
      error: e && e.message ? e.message : String(e),
      truncated,
    };
  }
  return { ok: false, code: 'unsupported-method', error: `cannot decode ${describeMethod(entry.method)}` };
}

function pathRisk(name) {
  if (name.includes('\u0000')) return 'name-contains-nul';
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('/') || name.startsWith('\\')) return 'unsafe-path';
  const parts = name.split(/[\\/]+/);
  if (parts.includes('..')) return 'unsafe-path';
  return null;
}

/**
 * @param {Uint8Array} u8
 * @param {{codec:{inflateSync:Function,Inflate:Function}, [k:string]:any}} options
 */
export function auditArchive(u8, options = {}) {
  const t0 = now();
  const codec = options.codec;
  if (!codec || typeof codec.inflateSync !== 'function') {
    throw new TypeError('auditArchive requires options.codec.inflateSync (fflate compatible)');
  }
  const limits = {
    maxEntryBytes: options.maxEntryBytes ?? DEFAULTS.maxEntryBytes,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULTS.maxTotalBytes,
    maxRatio: options.maxRatio ?? DEFAULTS.maxRatio,
  };
  const opts = { ...DEFAULTS, ...options };
  const findings = [];
  const entries = [];
  const fileSize = u8.length;

  const eocd = findEocd(u8);
  let cd = { entries: [], issues: [], complete: false };

  if (!eocd) {
    findings.push(
      finding('eocd-missing', 'critical', 'no End Of Central Directory record — the archive index is gone (truncated or overwritten)'),
    );
  } else {
    findings.push(...eocd.issues);
    cd = parseCentralDirectory(u8, eocd);
    findings.push(...cd.issues);
  }

  // Bytes before the first local header (self-extracting stub / prepended data).
  let firstLocal = -1;
  const scanCap = Math.min(fileSize - 4, 4 * 1024 * 1024);
  for (let i = 0; i <= scanCap; i++) {
    if (u32(u8, i) === SIG_LOCAL) {
      firstLocal = i;
      break;
    }
  }
  const prefixStub = firstLocal > 0 ? firstLocal : 0;
  if (prefixStub > 0) {
    findings.push(
      finding('prefix-stub', 'info', `${prefixStub} byte(s) precede the first local header (self-extracting stub or prepended data)`),
    );
  }

  let totalDecoded = 0;
  /** @type {Map<string, number>} */
  const seenNames = new Map();
  let verified = 0;
  let unverifiable = 0;
  let corrupt = 0;

  cd.entries.forEach((entry, i) => {
    const issues = [];
    const localHeader = opts.crossCheckLocalHeaders ? parseLocalHeader(u8, entry.localOffset) : null;
    let effectiveLocal = localHeader;

    if (opts.crossCheckLocalHeaders) {
      if (!localHeader) {
        // Some archives store offsets relative to the end of a prepended stub.
        const shifted = prefixStub > 0 ? parseLocalHeader(u8, entry.localOffset + prefixStub) : null;
        if (shifted) {
          effectiveLocal = shifted;
          issues.push(
            finding('offset-shift', 'warning', `local header offset ${entry.localOffset} is relative to the end of a ${prefixStub}-byte prefix`, { entry: i }),
          );
        } else {
          issues.push(
            finding('local-header-missing', 'error', `no valid local file header at offset ${entry.localOffset}`, { entry: i }),
          );
        }
      } else {
        if (localHeader.name !== entry.name) {
          issues.push(
            finding('local-name-mismatch', 'error', `local header name "${localHeader.name}" differs from central directory "${entry.name}"`, { entry: i }),
          );
        }
        if (localHeader.method !== entry.method) {
          issues.push(
            finding('local-method-mismatch', 'error', `local header says ${describeMethod(localHeader.method)}, central directory says ${describeMethod(entry.method)}`, { entry: i }),
          );
        }
        const usesDescriptor = (entry.flags & FLAG.DATA_DESCRIPTOR) !== 0;
        // ZIP64 streamed entries leave 0xFFFFFFFF placeholders in the local header
        // (real sizes live in the ZIP64 extra field / data descriptor). Comparing
        // them verbatim produced a false positive on Python's force_zip64 output.
        const localSaturated = localHeader.compressedSize === 0xffffffff || localHeader.uncompressedSize === 0xffffffff;
        if (!usesDescriptor && !localSaturated && localHeader.crc !== entry.crc) {
          issues.push(
            finding('local-crc-mismatch', 'warning', `local header CRC ${localHeader.crc.toString(16)} ≠ central directory CRC ${entry.crc.toString(16)}`, { entry: i }),
          );
        }
        if (!usesDescriptor && !localSaturated && localHeader.compressedSize !== entry.compressedSize) {
          issues.push(
            finding('local-size-mismatch', 'warning', `local header compressed size ${localHeader.compressedSize} ≠ central directory ${entry.compressedSize}`, { entry: i }),
          );
        }
      }
    }

    const risk = pathRisk(entry.name);
    if (risk) {
      issues.push(
        finding(
          risk,
          risk === 'name-contains-nul' ? 'critical' : 'error',
          risk === 'name-contains-nul' ? 'entry name contains a NUL byte' : `entry name "${entry.name}" can escape the extraction root`,
          { entry: i },
        ),
      );
    }
    if (entry.name === '__proto__' || entry.name === 'constructor' || entry.name === 'prototype') {
      issues.push(
        finding('unsafe-name', 'warning', `entry name "${entry.name}" collides with an Object prototype key`, { entry: i }),
      );
    }
    if (seenNames.has(entry.name)) {
      issues.push(
        finding('duplicate-name', 'warning', `name duplicated (first at entry ${seenNames.get(entry.name)}); plain object maps will silently keep one of them`, { entry: i }),
      );
    } else {
      seenNames.set(entry.name, i);
    }

    const encrypted = (entry.flags & FLAG.ENCRYPTED) !== 0;
    const supported = entry.method === METHOD.STORED || entry.method === METHOD.DEFLATE;
    let status = 'verified';
    let out = null;
    let crcOk = null;
    let actualSize = null;

    if (encrypted) {
      issues.push(finding('encrypted-entry', 'warning', 'entry is encrypted; payload cannot be verified', { entry: i }));
      status = 'unverifiable';
    } else if (!supported) {
      issues.push(
        finding('unsupported-method', 'warning', `${describeMethod(entry.method)} is not decodable by the codec; payload cannot be verified`, { entry: i }),
      );
      status = 'unverifiable';
    } else if (!effectiveLocal) {
      status = 'error';
    } else {
      const decoded = decodeEntry(u8, entry, effectiveLocal, codec, {
        maxEntryBytes: Math.min(limits.maxEntryBytes, limits.maxTotalBytes - totalDecoded),
      });
      if (!decoded.ok) {
        issues.push(finding(decoded.code, decoded.code === 'expansion-limit' ? 'critical' : 'error', decoded.error, { entry: i }));
        status = 'error';
      } else {
        out = decoded.data;
        totalDecoded += out.length;
        actualSize = out.length;
        if (decoded.truncated) {
          issues.push(
            finding('data-out-of-range', 'error', `entry data is truncated: ${fileSize - effectiveLocal.dataOffset} of ${entry.compressedSize} compressed bytes present`, { entry: i }),
          );
          status = 'error';
        }
        if (opts.verifyCrc) {
          const actual = crc32(out);
          crcOk = actual === entry.crc;
          if (!crcOk) {
            issues.push(
              finding(
                'crc-mismatch',
                'error',
                `CRC-32 mismatch: header ${entry.crc.toString(16).padStart(8, '0')}, payload ${actual.toString(16).padStart(8, '0')} — header or bytes are damaged`,
                { entry: i },
              ),
            );
            status = 'error';
          }
        }
        if (actualSize !== entry.uncompressedSize) {
          issues.push(
            finding('size-mismatch', 'warning', `decoded ${actualSize} bytes, header declares ${entry.uncompressedSize}`, { entry: i }),
          );
          if (status === 'verified') status = 'warning';
        }
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > limits.maxRatio && entry.uncompressedSize > 1024 * 1024) {
          issues.push(
            finding(
              'expansion-ratio',
              'warning',
              `expansion ratio ${(entry.uncompressedSize / entry.compressedSize).toFixed(0)}x exceeds ${limits.maxRatio}x — treat as untrusted`,
              { entry: i },
            ),
          );
          if (status === 'verified') status = 'warning';
        }
      }
    }

    if (entry.flags & FLAG.DATA_DESCRIPTOR) {
      issues.push(finding('data-descriptor', 'info', 'sizes live in a trailing data descriptor', { entry: i }));
    }

    // Structural findings decide the entry status too: a payload that decodes in
    // a header that contradicts the index is not "verified". Warnings alone do not
    // demote it — they still surface in the archive-level verdict.
    const entrySeverity = issues.reduce((acc, f) => worst(acc, f.severity), 'info');
    if (status !== 'unverifiable' && (entrySeverity === 'critical' || entrySeverity === 'error')) status = 'error';

    if (status === 'verified') verified++;
    else if (status === 'unverifiable') unverifiable++;
    else corrupt++;

    findings.push(...issues);
    entries.push({
      index: i,
      name: entry.name,
      method: entry.method,
      methodName: describeMethod(entry.method),
      flags: entry.flags,
      encrypted,
      zip64: entry.zip64,
      offset: entry.localOffset,
      dataOffset: effectiveLocal ? effectiveLocal.dataOffset : null,
      crc: { expected: entry.crc, actual: opts.verifyCrc && out ? crc32(out) : null, ok: crcOk },
      sizes: {
        compressedDeclared: entry.compressedSize,
        uncompressedDeclared: entry.uncompressedSize,
        uncompressedActual: actualSize,
      },
      status,
      severity: entrySeverity,
      recoverable: out != null || (supported && !encrypted),
      issues: issues.map((f) => f.code),
      ...(opts.returnData && out ? { data: out } : {}),
    });
  });

  const counts = findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    },
    { info: 0, warning: 0, error: 0, critical: 0 },
  );

  // When the index is unusable, tell the operator how much is still recoverable
  // instead of only saying "invalid zip data".
  let scannedCount = 0;
  if (!eocd || !cd.complete) {
    scannedCount = scanLocalHeaders(u8, { maxEntries: options.maxScanEntries ?? 200000 }).length;
    findings.push(
      finding(
        'scan-recoverable',
        'info',
        `${scannedCount} local file header(s) found by sequential scan — run "ziptriage salvage" to rebuild the index`,
      ),
    );
  }

  let verdict = 'clean';
  if (!eocd || !cd.complete) verdict = corrupt > 0 ? 'corrupt' : 'unreadable';
  else if (counts.error || counts.critical) verdict = 'corrupt';
  else if (counts.warning) verdict = 'warnings';
  if (verdict === 'clean' && unverifiable > 0) verdict = 'warnings';

  return {
    tool: 'ziptriage',
    version: options.version || '0.1.0',
    format: 'zip',
    file: { name: options.name || null, size: fileSize },
    container: {
      eocd: eocd ? { offset: eocd.offset, commentLength: eocd.commentLength, zip64: eocd.zip64 } : null,
      cdOffset: eocd ? eocd.cdOffset : null,
      cdSize: eocd ? eocd.cdSize : null,
      entriesDeclared: eocd ? eocd.entriesDeclared : null,
      entriesParsed: entries.length,
      cdComplete: cd.complete,
      prefixStub,
      entriesScanned: scannedCount,
    },
    entries,
    findings,
    summary: {
      entries: entries.length,
      verified,
      unverifiable,
      corrupt,
      info: counts.info,
      warnings: counts.warning,
      errors: counts.error,
      critical: counts.critical,
      decodedBytes: totalDecoded,
      verdict,
      exitCode: exitCodeFor(verdict),
      durationMs: Math.round((now() - t0) * 1000) / 1000,
    },
  };
}

export function exitCodeFor(verdict) {
  switch (verdict) {
    case 'clean':
      return 0;
    case 'warnings':
      return 3;
    case 'corrupt':
      return 4;
    default:
      return 5;
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
