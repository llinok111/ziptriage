/**
 * Salvage: recover everything that still decodes, then repack it into a fresh,
 * verifiable archive. Recovery is graded — never "all or nothing":
 *
 *   verified   CRC of the recovered bytes equals the CRC stored in the header
 *   partial    bytes decode but the header CRC disagrees (bit rot inside a
 *              stream that still inflates, or a stream cut short)
 *   unreadable nothing could be decoded
 */
import { crc32 } from './crc32.js';
import { FLAG, METHOD, concat } from './bytes.js';
import { auditArchive, decodeEntry } from './audit.js';
import { parseLocalHeader } from './parse.js';
import { scanLocalHeaders } from './scan.js';
import { buildZip } from './writer.js';

/**
 * Decode as much of a deflate stream as possible, keeping the bytes emitted
 * before the decoder hits the damage.
 *
 * Note on the fflate API: `Inflate.ondata` is a raw stream handler called as
 * `(chunk, final)`; decode errors are thrown from `push()`, not passed to the
 * callback (only the Unzip wrappers convert them to an `(err, data, final)` form).
 * @param {{Inflate:Function, inflateSync:Function}} codec
 * @param {Uint8Array} payload
 * @param {number} cap
 * @param {number} [expectedSize]
 */
export function inflatePartial(codec, payload, cap, expectedSize) {
  if (expectedSize != null && expectedSize >= 0 && expectedSize <= cap) {
    try {
      return { data: codec.inflateSync(payload, { out: new Uint8Array(expectedSize) }), error: null, partial: false };
    } catch (e) {
      // Fall through to the streaming decoder to keep whatever is decodable.
    }
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  let error = null;
  const sink = (d) => {
    if (d && d.length) {
      chunks.push(d.slice());
      total += d.length;
    }
  };
  try {
    const inflater = new codec.Inflate(sink);
    // Feed the stream in chunks with final=false: the decoder emits every block
    // it could complete, so damage near the tail costs only the tail.
    const CHUNK = 1 << 15;
    for (let o = 0; o < payload.length; o += CHUNK) inflater.push(payload.subarray(o, o + CHUNK), false);
    inflater.push(new Uint8Array(0), true);
  } catch (e) {
    error = e;
  }
  const data = concat(chunks);
  if (data.length > cap) {
    return { data: data.subarray(0, cap), error: error || new Error('salvage cap reached'), partial: true };
  }
  return { data, error, partial: !!error };
}

/** Make a recovered name safe to write out and unique inside the new archive. */
export function safeName(name, used = new Set()) {
  let n = name.replace(/\u0000/g, '').replace(/\\/g, '/');
  n = n.replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
  const parts = [];
  for (const seg of n.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') continue; // refuse to climb out
    parts.push(seg);
  }
  n = parts.join('/');
  if (!n) n = 'recovered.bin';
  let candidate = n;
  let i = 2;
  while (used.has(candidate)) candidate = `${n}~${i++}`;
  used.add(candidate);
  return candidate;
}

/**
 * @param {Uint8Array} u8
 * @param {{codec:any, maxEntryBytes?:number, maxTotalBytes?:number, selfVerify?:boolean, repack?:boolean}} options
 */
export function salvageArchive(u8, options = {}) {
  const codec = options.codec;
  if (!codec || typeof codec.inflateSync !== 'function') {
    throw new TypeError('salvageArchive requires options.codec (fflate compatible)');
  }
  const maxEntryBytes = options.maxEntryBytes ?? 256 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;

  const audit = auditArchive(u8, { ...options, returnData: true });
  /** @type {Map<number, any>} */
  const byOffset = new Map();
  /** @type {Array<any>} */
  const recovered = [];
  /** @type {Array<{name:string, reason:string}>} */
  const dropped = [];
  let totalBytes = 0;

  const accept = (name, data, method, crcExpected, source) => {
    if (!data) {
      dropped.push({ name, reason: 'no bytes decoded' });
      return;
    }
    if (totalBytes + data.length > maxTotalBytes) {
      dropped.push({ name, reason: 'archive-wide salvage budget exhausted' });
      return;
    }
    totalBytes += data.length;
    const actual = crc32(data);
    const grade = crcExpected != null && actual === crcExpected ? 'verified' : 'partial';
    recovered.push({
      name,
      data,
      method,
      grade,
      crc: { expected: crcExpected ?? null, actual },
      bytes: data.length,
      source,
    });
  };

  for (const e of audit.entries) {
    if (e.dataOffset != null) byOffset.set(e.dataOffset, e);
    if (e.data && (e.status === 'verified' || e.status === 'warning' || e.status === 'error')) {
      accept(e.name, e.data, e.method === METHOD.STORED ? METHOD.STORED : METHOD.DEFLATE, e.crc.expected, 'central-directory');
    } else if (e.crc.ok === false) {
      // Bytes decoded but damaged: keep them, flagged partial, do not silently drop.
      dropped.push({ name: e.name, reason: 'decoded bytes failed CRC and were discarded by the auditor' });
    } else if (e.status === 'unverifiable') {
      dropped.push({ name: e.name, reason: e.encrypted ? 'encrypted entry' : `unsupported method ${e.methodName}` });
    } else if (e.status === 'error') {
      dropped.push({ name: e.name, reason: e.issues.join(', ') || 'unreadable' });
    }
  }

  // Second pass: local headers the index never mentioned (destroyed/stale CD).
  const scanned = scanLocalHeaders(u8, { maxEntries: options.maxEntries ?? 200000 });
  let scanOnly = 0;
  for (const cand of scanned) {
    if (byOffset.has(cand.dataOffset)) continue; // already handled above
    const header = cand.header;
    if (header.flags & FLAG.ENCRYPTED) {
      dropped.push({ name: header.name, reason: 'encrypted entry (local header scan)' });
      continue;
    }
    if (header.method !== METHOD.STORED && header.method !== METHOD.DEFLATE) {
      dropped.push({ name: header.name, reason: `unsupported method ${header.method} (local header scan)` });
      continue;
    }
    const payload = u8.subarray(cand.dataOffset, cand.dataEnd);
    if (header.method === METHOD.STORED) {
      accept(header.name, payload, METHOD.STORED, cand.sizeTrusted ? header.crc : null, 'local-header-scan');
    } else {
      const limited = Math.min(maxEntryBytes, maxTotalBytes - totalBytes);
      if (limited <= 0) {
        dropped.push({ name: header.name, reason: 'archive-wide salvage budget exhausted' });
        continue;
      }
      const part = inflatePartial(codec, payload, limited, cand.sizeTrusted ? header.uncompressedSize : undefined);
      if (part.data.length === 0 && part.error) {
        dropped.push({ name: header.name, reason: `deflate: ${part.error.message || 'undecodable stream'}` });
        continue;
      }
      accept(header.name, part.data, METHOD.DEFLATE, cand.sizeTrusted ? header.crc : null, 'local-header-scan');
    }
    scanOnly++;
  }

  const used = new Set();
  const files = recovered.map((r) => ({ name: safeName(r.name, used), data: r.data }));
  /** @type {Array<{from:string,to:string}>} */
  const renamed = [];
  recovered.forEach((r, i) => {
    if (files[i].name !== r.name) renamed.push({ from: r.name, to: files[i].name });
    r.repackedName = files[i].name;
  });

  const repack = options.repack === false ? null : buildZip(files, { codec, level: options.level ?? 6 });
  let selfCheck = null;
  if (repack && options.selfVerify !== false) {
    const re = auditArchive(repack, { codec, verifyCrc: true });
    selfCheck = {
      entries: re.summary.entries,
      verdict: re.summary.verdict,
      verified: re.summary.verified,
      bytes: repack.length,
    };
  }

  const verifiedCount = recovered.filter((r) => r.grade === 'verified').length;
  return {
    tool: 'ziptriage',
    version: options.version || '0.1.0',
    source: {
      size: u8.length,
      verdict: audit.summary.verdict,
      cdComplete: audit.container.cdComplete,
      entriesIndexed: audit.container.entriesParsed,
      entriesScanned: scanned.length,
      entriesFromScanOnly: scanOnly,
    },
    recovered,
    files,
    dropped,
    renamed,
    archive: repack,
    summary: {
      recovered: recovered.length,
      verified: verifiedCount,
      partial: recovered.length - verifiedCount,
      dropped: dropped.length,
      renamed: renamed.length,
      bytes: totalBytes,
      outBytes: repack ? repack.length : 0,
      selfCheck,
    },
  };
}
