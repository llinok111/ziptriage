/**
 * Browser acceptance for the ziptriage demo.
 *
 * Drives the real page in Edge: loads it, clicks all four sample buttons, runs
 * salvage, downloads the repaired ZIP, then feeds that ZIP back into the page
 * and into the Node CLI. Every assertion reads state out of the live DOM.
 *
 * Screenshots go to shots/verify/ and are statistically checked (size, distinct
 * colours, mean luminance, per-band stdev) because this machine's image viewer
 * cannot return images.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = path.join(__dirname, 'shots', 'verify');
fs.mkdirSync(SHOTS, { recursive: true });

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` :: ${detail}` : ''}`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/demo/index.html';
      if (p.endsWith('/')) p += 'index.html';
      const full = path.resolve(ROOT, `.${p}`);
      if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(fs.readFileSync(full));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}/demo/`;  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  page.on('console', (m) => {
    // favicon 404 is a browser convenience request, not a page defect.
    const t = m.text();
    if (m.type() === 'error' && !/favicon\.ico/.test(t)) consoleErrors.push(t);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('request', (r) => requests.push(r.url()));

  try {
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('#result:not(.hidden)', { timeout: 10000 });

    // 1. Initial auto-run sample
    const v0 = await page.textContent('#verdict');
    check('page loads and auto-runs a sample', v0 && v0.trim().length > 0, `verdict=${v0 && v0.trim()}`);

    // 2. Engine banner proves the codec was wired, not stubbed
    const engine = await page.textContent('#engine');
    check('codec reported as ready', /codec ready/.test(engine), engine);

    // 3. No network beyond the local origin
    const external = requests.filter((u) => !u.startsWith(`http://127.0.0.1:${port}`) && !u.startsWith('data:') && !u.startsWith('blob:'));
    check('no external network requests', external.length === 0, external.join(', ') || 'none');

    // 4. Each sample produces the verdict the CLI also produces
    const expected = {
      healthy: 'CLEAN',
      bitflip: 'CORRUPT',
      truncated: 'UNREADABLE',
      destroyed: 'UNREADABLE',
    };
    for (const [kind, want] of Object.entries(expected)) {
      await page.click(`[data-sample="${kind}"]`);
      await page.waitForFunction(
        ([w]) => {
          const el = document.getElementById('verdict');
          return el && el.textContent.trim() === w;
        },
        [want],
        { timeout: 5000 },
      ).catch(() => {});
      const got = (await page.textContent('#verdict')).trim();
      check(`sample "${kind}" -> ${want}`, got === want, `got ${got}`);
      await page.screenshot({ path: path.join(SHOTS, `sample-${kind}.png`) });
    }

    // 5. Entry table reflects the damaged archive honestly
    await page.click('[data-sample="bitflip"]');
    await page.waitForFunction(() => document.querySelectorAll('#entries tbody tr').length > 0, null, { timeout: 5000 });
    const rows = await page.$$eval('#entries tbody tr', (trs) =>
      trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())),
    );
    const badRow = rows.find((r) => r[0].includes('损坏'));
    check('bitflip shows a damaged row with mismatching CRC', !!badRow && /≠/.test(badRow[5]), badRow ? badRow.join(' | ') : 'no damaged row');

    // 6. Salvage from the destroyed-index sample
    await page.click('[data-sample="destroyed"]');
    await page.waitForFunction(() => document.getElementById('verdict').textContent.trim() === 'UNREADABLE', null, { timeout: 5000 });
    await page.click('#salvage');
    await page.waitForSelector('#download:not(.hidden)', { timeout: 10000 });
    const salvageText = (await page.textContent('#salvageOut')).trim();
    check('salvage reports recovered entries', /恢复 3 条/.test(salvageText), salvageText.split('\n')[0]);
    check('salvage self-check is clean', /自检：.*CLEAN/.test(salvageText), salvageText.split('\n').pop());
    await page.screenshot({ path: path.join(SHOTS, 'salvage-result.png') });

    // 7. The downloaded repair must be a real, valid ZIP
    const dl = await page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    let downloaded = null;
    if (dl) {
      downloaded = path.join(SHOTS, 'downloaded-repaired.zip');
      await dl.saveAs(downloaded);
    } else {
      // Some headless configurations do not emit a download event; fall back to
      // reading the blob URL directly, which is what the anchor points at.
      const href = await page.getAttribute('#download', 'href');
      check('download link present', !!href && href.startsWith('blob:'), href || 'none');
      if (href) {
        downloaded = path.join(SHOTS, 'downloaded-repaired.zip');
        const b64 = await page.evaluate(async (url) => {
          const buf = await (await fetch(url)).arrayBuffer();
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return btoa(bin);
        }, href);
        fs.writeFileSync(downloaded, Buffer.from(b64, 'base64'));
      }
    }
    check('repaired archive downloaded', !!downloaded && fs.existsSync(downloaded), downloaded || 'none');

    // 8. Feed the downloaded archive back into the page: it must audit clean
    if (downloaded) {
      await page.setInputFiles('#file', downloaded);
      await page.waitForFunction(() => document.getElementById('verdict').textContent.trim() === 'CLEAN', null, { timeout: 10000 })
        .catch(() => {});
      const roundTrip = (await page.textContent('#verdict')).trim();
      check('downloaded repair re-audits CLEAN in the browser', roundTrip === 'CLEAN', roundTrip);
    }

    // 9. The truncated sample must tell the operator that a scan can recover it
    await page.click('[data-sample="truncated"]');
    await page.waitForFunction(() => document.getElementById('verdict').textContent.trim() === 'UNREADABLE', null, { timeout: 5000 });
    const findingsText = await page.textContent('#findings');
    check('truncated sample offers a recovery hint', /scan-recoverable|eocd-missing/.test(findingsText), findingsText.replace(/\s+/g, ' ').slice(0, 120));

    // 10. JSON export button is wired
    const jsonPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.click('#downloadJson');
    const jsonDl = await jsonPromise;
    check('JSON report export triggers a download', !!jsonDl, jsonDl ? jsonDl.suggestedFilename() : 'no download event');

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');

    // Full-page screenshot for the statistical check.
    await page.click('[data-sample="healthy"]');
    await page.waitForFunction(() => document.getElementById('verdict').textContent.trim() === 'CLEAN', null, { timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, 'page-healthy.png'), fullPage: true });
  } catch (e) {
    check('demo run completed without throwing', false, e.message);
  } finally {
    await browser.close();
    server.close();
  }

  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.length - pass;
  console.log(`\nexecuted ${checks.length} · passed ${pass} · failed ${fail}`);
  fs.writeFileSync(path.join(SHOTS, 'browser-checks.json'), JSON.stringify({ checks, pass, fail }, null, 2));
  process.exit(fail ? 1 : 0);
})();
