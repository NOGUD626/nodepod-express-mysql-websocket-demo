import { Nodepod } from '@scelar/nodepod';
import { packageJson, serverJs, wsStream, vmIndexHtml } from './vm-project';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const statusEl = $('#status');
const logEl = $('#log') as HTMLPreElement;
const resultEl = $('#result') as HTMLPreElement;
const previewEl = $('#preview') as HTMLIFrameElement;
const bootBtn = $('#boot') as HTMLButtonElement;
const apiButtons = Array.from(
  document.querySelectorAll('button.api'),
) as HTMLButtonElement[];

let nodepod: any = null;
let previewUrl = '';

function setStatus(text: string) {
  statusEl.innerHTML = '状態: <b>' + text + '</b>';
}
function log(line: string) {
  logEl.textContent += '\n' + line;
  logEl.scrollTop = logEl.scrollHeight;
}
// ANSI エスケープ（色・カーソル制御）を除去して読みやすくする
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function logRaw(chunk: string) {
  logEl.textContent += chunk.replace(ANSI, '');
  logEl.scrollTop = logEl.scrollHeight;
}

async function boot() {
  bootBtn.disabled = true;
  logEl.textContent = '';
  const t0 = performance.now();
  setStatus('NodePod を起動中…');
  log('[host] Nodepod.boot() ...');

  nodepod = await Nodepod.boot({
    // 仮想 FS にマウントするファイル
    files: {
      '/package.json': packageJson,
      '/server.js': serverJs,
      '/ws-stream.js': wsStream,
      '/www/index.html': vmIndexHtml,
    },
    // npm install のための外部ドメイン許可（npm/github/esm.sh は組み込みで既定許可）。
    // WebSocket(ws://localhost:8090) はブラウザのネットワーク層を直接使うため、
    // ここの fetch allowlist とは別系統（CORS プロキシを経由しない）。
    allowedFetchDomains: [],
    // COOP/COEP ヘッダー無しでも動くよう SAB を切る（Express デモには不要）
    enableSharedArrayBuffer: false,
    // Express が listen() した瞬間に呼ばれる
    onServerReady: (port: number, url: string) => {
      previewUrl = url;
      log('\n[host] server-ready! port=' + port + ' url=' + url);
      previewEl.src = url;
      previewEl.classList.remove('hidden');
      const ph = document.getElementById('preview-placeholder');
      if (ph) ph.style.display = 'none';
      apiButtons.forEach((b) => (b.disabled = false));
      const ms = Math.round(performance.now() - t0);
      setStatus('起動完了 ✅（' + ms + 'ms / Express 稼働中）');
    },
  });

  const bootMs = Math.round(performance.now() - t0);
  log('[host] booted in ' + bootMs + 'ms. installing express + mysql2...');
  setStatus('express + mysql2 を npm install 中…');

  // npm install express mysql2（ログを流す）
  const inst = await nodepod.spawn('npm', ['install', 'express', 'mysql2']);
  inst.on('output', logRaw);
  inst.on('error', logRaw);
  await inst.completion;
  log('\n[host] npm install done. starting server...');
  setStatus('server.js を起動中…');

  // node server.js（常駐するので completion は待たない）
  const server = await nodepod.spawn('node', ['server.js']);
  server.on('output', logRaw);
  server.on('error', logRaw);
}

async function callApi(path: string) {
  if (!previewUrl) return;
  resultEl.textContent = 'GET ' + path + ' …';
  try {
    const base = previewUrl.replace(/\/$/, '');
    const r = await fetch(base + path);
    const text = await r.text();
    let body = text;
    try {
      body = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* keep raw */
    }
    resultEl.textContent = 'GET ' + path + '  →  HTTP ' + r.status + '\n\n' + body;
  } catch (e: any) {
    resultEl.textContent =
      'GET ' + path + '  →  失敗: ' + (e?.message || String(e));
  }
}

bootBtn.addEventListener('click', () => {
  boot().catch((e) => {
    log('\n[host] ERROR: ' + (e?.message || String(e)));
    setStatus('エラー ❌（ログ参照）');
    bootBtn.disabled = false;
  });
});

apiButtons.forEach((b) =>
  b.addEventListener('click', () => callApi(b.dataset.path!)),
);
