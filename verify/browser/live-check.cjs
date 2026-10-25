const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const URL = process.env.ZT_URL || 'https://llinok111.github.io/ziptriage/';
const SHOTS = path.join(__dirname, 'shots', 'verify');
fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const external = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('request', (r) => external.push(r.url()));

  await page.goto(URL, { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('#result:not(.hidden)', { timeout: 20000 });

  const verdict = (await page.textContent('#verdict')).trim();
  const engine = await page.textContent('#engine');
  const rows = await page.$$eval('#entries tbody tr', (t) => t.length);
  const findings = await page.$$eval('#findings li', (l) => l.length);

  // Click through the samples on the live site too.
  await page.click('[data-sample="destroyed"]');
  await page.waitForFunction(() => document.getElementById('verdict').textContent.trim() === 'UNREADABLE', null, { timeout: 10000 });
  await page.click('#salvage');
  await page.waitForSelector('#download:not(.hidden)', { timeout: 15000 });
  const salvage = (await page.textContent('#salvageOut')).trim().split('\n');

  await page.screenshot({ path: path.join(SHOTS, 'live-pages.png'), fullPage: true });
  await browser.close();

  const offOrigin = external.filter((u) => !u.startsWith('https://llinok111.github.io/') && !u.startsWith('data:') && !u.startsWith('blob:'));
  const out = {
    url: URL,
    verdict,
    engine,
    tableRows: rows,
    findingLines: findings,
    salvageFirstLine: salvage[0],
    salvageLastLine: salvage[salvage.length - 1],
    errors,
    offOriginRequests: offOrigin,
  };
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(SHOTS, 'live-check.json'), JSON.stringify(out, null, 2));
  const ok = verdict === 'CLEAN' && rows > 0 && /codec ready/.test(engine) && errors.length === 0 && offOrigin.length === 0 && /恢复 3 条/.test(salvage[0]);
  console.log(ok ? 'LIVE OK' : 'LIVE FAIL');
  process.exit(ok ? 0 : 1);
})();
