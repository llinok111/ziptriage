#!/usr/bin/env node
/**
 * Copies the upstream fflate UMD build into demo/vendor so the page can run with
 * zero bundler and zero network. Also asserts the demo never references a remote
 * resource — a reviewer behind a firewall must get identical behaviour.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'fflate', 'umd', 'index.js');
const dest = join(root, 'demo', 'vendor', 'fflate.umd.js');

if (!existsSync(src)) {
  console.error(`missing ${src} — run "npm install" first`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
const size = statSync(dest).size;
if (size < 10000) {
  console.error(`vendor copy looks wrong: ${size} bytes`);
  process.exit(1);
}

const html = readFileSync(join(root, 'demo', 'index.html'), 'utf8');
const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
if (remote.length) {
  console.error(`demo must not fetch remote assets: ${remote.join(', ')}`);
  process.exit(1);
}

console.log(`demo/vendor/fflate.umd.js ${(size / 1024).toFixed(1)} KB · no remote assets`);
console.log('serve with:  node scripts/serve-demo.js   (or any static server rooted at the repo)');
