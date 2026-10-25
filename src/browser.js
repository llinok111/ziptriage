/**
 * Browser entry point. Same container layer, codec handed in from the global
 * fflate UMD build so the demo needs no bundler and no network at runtime.
 */
import { auditArchive } from './core/audit.js';
import { salvageArchive } from './core/salvage.js';
import { formatAudit, formatSalvage } from './core/report.js';

export const VERSION = '0.1.0';

export function fromGlobal(fflate) {
  if (!fflate || typeof fflate.inflateSync !== 'function') {
    throw new Error('fflate UMD build not found on window.fflate');
  }
  const codec = { inflateSync: fflate.inflateSync, deflateSync: fflate.deflateSync, Inflate: fflate.Inflate };
  return {
    version: VERSION,
    codec,
    audit: (u8, opts = {}) => auditArchive(u8, { ...opts, codec, version: VERSION }),
    salvage: (u8, opts = {}) => salvageArchive(u8, { ...opts, codec, version: VERSION }),
    formatAudit,
    formatSalvage,
  };
}

export { auditArchive, salvageArchive, formatAudit, formatSalvage };
