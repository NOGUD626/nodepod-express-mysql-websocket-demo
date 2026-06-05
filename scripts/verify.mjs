/**
 * デモを自動操作して、各 API の JSON 結果を標準出力に出す検証スクリプト。
 *   npm run dev / npm run db:up / npm run proxy を起動した状態で:
 *   node scripts/verify.mjs
 */
import { chromium } from 'playwright';

const URL = process.env.DEMO_URL || 'http://localhost:5173/';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => console.log('  [page]', m.text()));

  console.log('→ open ' + URL);
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

  console.log('→ click 起動（NodePod boot → npm install express mysql2 → node server.js）...');
  await page.click('#boot');

  console.log('→ wait for server-ready（最大 5 分）...');
  await page.waitForSelector('button.api:not([disabled])', { timeout: 300000 });
  console.log('✓ Express 起動完了');

  const previewUrl = await page.$eval('#preview', (el) => el.src);
  const hit = async (path) => {
    const out = await page.evaluate(
      async (args) => {
        const r = await fetch(args.base.replace(/\/$/, '') + args.path);
        return { status: r.status, body: await r.text() };
      },
      { base: previewUrl, path },
    );
    console.log('\n========== ' + path + ' (HTTP ' + out.status + ') ==========');
    try {
      console.log(JSON.stringify(JSON.parse(out.body), null, 2));
    } catch {
      console.log(out.body);
    }
  };

  await hit('/api/hello');
  await hit('/api/db');
  await hit('/api/db-insert');
  await hit('/api/db-advanced');

  console.log('\n✓ done');
} catch (e) {
  console.error('✗ failed:', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
