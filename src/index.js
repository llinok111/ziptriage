/**
 * Node entry point. The only place fflate is imported: the container layer
 * (parse/audit/salvage/writer) talks to an injected codec so it also runs in a
 * browser, and so the codec can be swapped in tests.
 */
import { inflateSync, deflateSync, Inflate } from 'fflate';
import { auditArchive } from './core/audit.js';
import { salvageArchive } from './core/salvage.js';
import { formatAudit, formatSalvage } from './core/report.js';
import { crc32 } from './core/crc32.js';

export const VERSION = '0.1.0';
export const codec = { inflateSync, deflateSync, Inflate };

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('expected a Uint8Array, ArrayBuffer or Buffer');
}

/** @param {Uint8Array|ArrayBuffer} input */
export function audit(input, options = {}) {
  return auditArchive(toBytes(input), { ...options, codec, version: VERSION });
}

/** @param {Uint8Array|ArrayBuffer} input */
export function salvage(input, options = {}) {
  return salvageArchive(toBytes(input), { ...options, codec, version: VERSION });
}

export { auditArchive, salvageArchive, formatAudit, formatSalvage, crc32 };
export { buildZip } from './core/writer.js';
export { scanLocalHeaders } from './core/scan.js';
export { DEFAULTS } from './core/audit.js';
