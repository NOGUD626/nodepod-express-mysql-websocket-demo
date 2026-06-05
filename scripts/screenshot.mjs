/**
 * デモを自動操作してスクリーンショットを docs/ に保存する。
 *
 * 事前に dev サーバーを起動しておくこと:
 *   npm run dev      （別ターミナルで）
 * その後:
 *   npm run screenshot
 *
 * ※ ヘッドレスは新規プロファイル = IndexedDB キャッシュが空なので、
 *    初回の npm install に最大 2 分程度かかる（待機を長めに取ってある）。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(__dirname, '..', 'docs');
const URL = process.env.DEMO_URL || 'http://localhost:5173/';

fs.mkdirSync(docsDir, { recursive: true });

const shot = (page, name) =>
  page.screenshot({ path: path.join(docsDir, name), fullPage: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.on('console', (m) => console.log('  [page]', m.text()));

  console.log('→ open ' + URL);
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

  console.log('→ click 起動 ...');
  await page.click('#boot');

  console.log('→ wait for server-ready（npm install 待ち, 最大 4 分）...');
  await page.waitForSelector('button.api:not([disabled])', { timeout: 240000 });
  await page.waitForTimeout(1500);
  await shot(page, 'screenshot-ready.png');
  console.log('  saved docs/screenshot-ready.png');

  console.log('→ /api/catfact ...');
  await page.click('button.api[data-path="/api/catfact"]');
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#result')?.textContent || '';
      return t.includes('/api/catfact') && t.includes('HTTP');
    },
    { timeout: 30000 },
  );
  await page.waitForTimeout(800);
  await shot(page, 'screenshot-catfact.png');
  console.log('  saved docs/screenshot-catfact.png');

  console.log('→ /api/blocked ...');
  await page.click('button.api[data-path="/api/blocked"]');
  await page.waitForFunction(
    () => {
      const t = document.querySelector('#result')?.textContent || '';
      return t.includes('/api/blocked') && t.includes('HTTP');
    },
    { timeout: 30000 },
  );
  await page.waitForTimeout(800);
  await shot(page, 'screenshot-blocked.png');
  console.log('  saved docs/screenshot-blocked.png');

  console.log('✓ done');
} catch (e) {
  console.error('✗ failed:', e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
