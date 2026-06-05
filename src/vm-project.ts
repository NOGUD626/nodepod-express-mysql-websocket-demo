/**
 * ここに書いた文字列が「ブラウザ内 NodePod」へマウントされる
 * 仮想ファイルシステム上のファイル中身になります。
 * （ローカルの本物のディスクには書かれません）
 *
 * このデモの肝：
 *   ブラウザ内で動く本物の mysql2 ドライバ（無改造）の `stream` オプションに、
 *   「ブラウザの WebSocket を Node の Duplex に見せかけたもの」を渡す。
 *   mysql2 は net.Socket を使っているつもりで、実体は WebSocket。
 *   そのバイトは WebSocket → ホストの proxy → 本物の TCP → MySQL に届く。
 */

// 仮想 FS 上の /package.json
export const packageJson = JSON.stringify(
  {
    name: 'in-browser-mysql-app',
    private: true,
    type: 'commonjs',
    dependencies: {
      express: '^4.19.2',
      mysql2: '^3.11.0',
    },
  },
  null,
  2,
);

// ブラウザの WebSocket を Node の Duplex に見せかけるラッパー。
// CommonJS の文字列として仮想 FS に置くため、テンプレートリテラルは使わず連結で書く。
const wsStreamJs = `
const { Duplex } = require('stream');

/**
 * ブラウザの WebSocket を Node の Duplex として見せかける。
 * mysql2 は stream を net.Socket とみなして読み書きするが、実体は WebSocket。
 */
function createWebSocketStream(url) {
  // NodePod (WASM Node) でも、ブラウザの WebSocket は globalThis に露出している想定。
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error('globalThis.WebSocket が見つかりません（NodePod が WebSocket をブラウザに委譲していない可能性）');

  const ws = new WS(url);
  ws.binaryType = 'arraybuffer';

  let open = false;
  const queue = [];

  const duplex = new Duplex({
    read() {}, // push 駆動なので何もしない
    write(chunk, _enc, cb) {
      // chunk は Buffer（Uint8Array 派生）。WebSocket はそのまま送れる。
      if (open) { try { ws.send(chunk); } catch (e) { return cb(e); } cb(); }
      else queue.push({ chunk, cb });
    },
    final(cb) { try { ws.close(); } catch (e) {} cb(); },
  });

  // mysql2 は net.Socket とみなして以下を呼ぶことがあるので no-op スタブ
  duplex.setNoDelay = () => duplex;
  duplex.setTimeout = () => duplex;
  duplex.setKeepAlive = () => duplex;
  duplex.ref = () => duplex;
  duplex.unref = () => duplex;

  ws.addEventListener('open', () => {
    open = true;
    for (const { chunk, cb } of queue) { try { ws.send(chunk); cb(); } catch (e) { cb(e); } }
    queue.length = 0;
    duplex.emit('connect'); // mysql2 が socket 同様 'connect' を待つ場合に備える
  });

  ws.addEventListener('message', (ev) => {
    const data = ev.data;
    // ブラウザ WebSocket は ArrayBuffer で届く（binaryType='arraybuffer'）
    const buf = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data))
              : Buffer.from(data);
    duplex.push(buf);
  });

  ws.addEventListener('close', () => duplex.push(null));
  ws.addEventListener('error', () => duplex.destroy(new Error('WebSocket error')));

  return duplex;
}

module.exports = { createWebSocketStream };
`;

// 仮想 FS 上の /server.js（ブラウザ内で動く Express + mysql2 サーバー本体）
export const serverJs = `
// --- NodePod の Buffer は ES class 実装(_BufferPolyfill)で、レガシーな Buffer(...)
//     （new 無し呼び）を許さない。mysql2 やその依存(iconv-lite 等)が内部で使うため、
//     buffer モジュールの Buffer を Proxy でラップして new 無し呼びを alloc/from に転送する。
//     Proxy なら construct(new Buffer)はそのまま、apply(Buffer())だけ救済できる。
(function () {
  const bufMod = require('buffer');
  const Real = bufMod.Buffer;
  // NodePod の Buffer.allocUnsafe は内部プール(slice)管理に難があり、mysql2 が使うと
  // "offset is out of bounds" を起こすため、ゼロ初期化の alloc に寄せて回避する。
  try { Real.allocUnsafe = Real.alloc.bind(Real); } catch (e) {}
  try { Real.allocUnsafeSlow = Real.alloc.bind(Real); } catch (e) {}
  // NodePod の Buffer.prototype.copy は target の境界計算を誤り、内部の set() で
  // "offset is out of bounds" を起こす（mysql2 の認証パケット組み立てで発生）。
  // 安全なバイト単位コピーに差し替える。
  try {
    Real.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
      targetStart = targetStart || 0;
      sourceStart = sourceStart || 0;
      sourceEnd = sourceEnd === undefined || sourceEnd === null ? this.length : sourceEnd;
      let n = 0;
      for (let i = sourceStart; i < sourceEnd && targetStart + n < target.length; i++) {
        target[targetStart + n] = this[i];
        n++;
      }
      return n;
    };
  } catch (e) {}
  // NodePod の subarray/slice は範囲外オフセットで throw する（Node 標準は clamp する）。
  // mysql2 の binary(prepared) 結果 parse で "Start offset N is outside the bounds" が
  // 出るため、Node 標準と同じく範囲を clamp する薄いラッパーに差し替える（ゼロコピー維持）。
  try {
    const origSub = Real.prototype.subarray;
    const clamp = function (s, e) {
      const len = this.length;
      s = s === undefined ? 0 : (s | 0);
      s = s < 0 ? Math.max(len + s, 0) : Math.min(s, len);
      e = e === undefined || e === null ? len : (e | 0);
      e = e < 0 ? Math.max(len + e, 0) : Math.min(e, len);
      if (e < s) e = s;
      return origSub.call(this, s, e);
    };
    Real.prototype.subarray = clamp;
    Real.prototype.slice = clamp;
  } catch (e) {}
  // NodePod の Buffer.prototype.toString は start/end 範囲引数を無視して全体を返す。
  // mysql2 は列名や文字列を toString('utf8', start, end) で範囲切り出しするため、
  // 範囲を尊重する正しい実装に差し替える（全体変換自体は正しいので範囲時のみコピー）。
  try {
    const origToString = Real.prototype.toString;
    Real.prototype.toString = function (enc, start, end) {
      enc = enc || 'utf8';
      start = start || 0;
      end = end === undefined || end === null ? this.length : end;
      if (start <= 0 && end >= this.length) return origToString.call(this, enc);
      const sub = Real.alloc(Math.max(end - start, 0));
      for (let i = 0; i < sub.length; i++) sub[i] = this[start + i];
      return origToString.call(sub, enc);
    };
  } catch (e) {}
  // NodePod の writeDoubleLE/readDoubleLE 等は new DataView(this.buffer, byteOffset+offset)
  // を作るが backing と byteOffset が不整合で "offset is outside the bounds" になる。
  // mysql2 は数値 prepared パラメータを DOUBLE で書くためここで失敗する。
  // 独立 ArrayBuffer 上の DataView を介してバイト単位で読み書きする実装に差し替える。
  try {
    const proto = Real.prototype;
    const makeWriter = (bytes, setter, le) => function (value, offset) {
      offset = offset || 0;
      const dv = new DataView(new ArrayBuffer(bytes));
      dv[setter](0, value, le);
      for (let i = 0; i < bytes; i++) this[offset + i] = dv.getUint8(i);
      return offset + bytes;
    };
    const makeReader = (bytes, getter, le) => function (offset) {
      offset = offset || 0;
      const dv = new DataView(new ArrayBuffer(bytes));
      for (let i = 0; i < bytes; i++) dv.setUint8(i, this[offset + i]);
      return dv[getter](0, le);
    };
    proto.writeDoubleLE = makeWriter(8, 'setFloat64', true);
    proto.writeDoubleBE = makeWriter(8, 'setFloat64', false);
    proto.writeFloatLE = makeWriter(4, 'setFloat32', true);
    proto.writeFloatBE = makeWriter(4, 'setFloat32', false);
    proto.readDoubleLE = makeReader(8, 'getFloat64', true);
    proto.readDoubleBE = makeReader(8, 'getFloat64', false);
    proto.readFloatLE = makeReader(4, 'getFloat32', true);
    proto.readFloatBE = makeReader(4, 'getFloat32', false);
  } catch (e) {}

  const BufProxy = new Proxy(Real, {
    apply(target, _thisArg, args) {
      if (typeof args[0] === 'number') return target.alloc(args[0]);
      return target.from.apply(target, args);
    },
  });
  try { bufMod.Buffer = BufProxy; } catch (e) {}
  try { globalThis.Buffer = BufProxy; } catch (e) {}
})();

// --- NodePod の crypto.createHash は正しいダイジェストを返さない（ダミー値）。
//     mysql_native_password の認証スクランブルは SHA1 ベースなので、正しい純 JS の
//     SHA1 実装で createHash('sha1') を差し替えないと必ず Access denied になる。
(function () {
  const crypto = require('crypto');
  if (crypto.__sha1patched) return;
  const origCreateHash = crypto.createHash.bind(crypto);

  function toBytes(data, enc) {
    if (data == null) return new Uint8Array(0);
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, enc || 'utf8'));
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(Buffer.from(data));
  }

  function sha1(message) {
    const rotl = (n, s) => (n << s) | (n >>> (32 - s));
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const ml = message.length * 8;
    const bytes = Array.from(message);
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(0, 0, 0, 0, (ml >>> 24) & 0xff, (ml >>> 16) & 0xff, (ml >>> 8) & 0xff, ml & 0xff);
    for (let i = 0; i < bytes.length; i += 64) {
      const w = new Array(80);
      for (let j = 0; j < 16; j++) {
        w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) | (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3];
      }
      for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const tmp = (rotl(a, 5) + f + e + k + w[j]) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    const out = new Uint8Array(20);
    [h0, h1, h2, h3, h4].forEach((h, idx) => {
      out[idx * 4] = (h >>> 24) & 0xff; out[idx * 4 + 1] = (h >>> 16) & 0xff;
      out[idx * 4 + 2] = (h >>> 8) & 0xff; out[idx * 4 + 3] = h & 0xff;
    });
    return out;
  }

  crypto.createHash = function (algo) {
    if (String(algo).toLowerCase() === 'sha1') {
      const chunks = [];
      return {
        update(data, enc) { chunks.push(toBytes(data, enc)); return this; },
        digest(enc) {
          let total = 0; for (const c of chunks) total += c.length;
          const all = new Uint8Array(total); let o = 0;
          for (const c of chunks) { all.set(c, o); o += c.length; }
          const buf = Buffer.from(sha1(all));
          return enc ? buf.toString(enc) : buf; // hex/base64/latin1 等すべて対応
        },
      };
    }
    return origCreateHash(algo);
  };
  crypto.__sha1patched = true;
})();

const express = require('express');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { createWebSocketStream } = require('./ws-stream.js');

const app = express();
const PORT = 3000;

// ホストの WebSocket⇄TCP プロキシ。ブラウザから見て localhost:8090。
const WS_URL = 'ws://localhost:8090';

function connectMysql() {
  return mysql.createConnection({
    user: 'demo',
    password: 'demopass',
    database: 'demodb',
    charset: 'utf8mb4',
    // ★ ここが肝：TCP ソケットの代わりに WebSocket 製の Duplex を渡す
    stream: () => createWebSocketStream(WS_URL),
  });
}

// (0) 生存確認
app.get('/api/hello', (req, res) => {
  res.json({
    message: 'Hello from in-browser Express + mysql2',
    node: process.version,
    platform: process.platform,
    hasWebSocket: typeof globalThis.WebSocket !== 'undefined',
    time: new Date().toISOString(),
  });
});

// (1) WebSocket がブラウザ側に到達できるかだけを切り分けるプローブ
app.get('/api/ws-probe', (req, res) => {
  const WS = globalThis.WebSocket;
  if (!WS) return res.status(500).json({ ok: false, reason: 'globalThis.WebSocket なし' });
  const ws = new WS(WS_URL);
  ws.binaryType = 'arraybuffer';
  let done = false;
  const finish = (obj) => { if (done) return; done = true; try { ws.close(); } catch (e) {} res.json(obj); };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout 5s（proxy に届いていない可能性）' }), 5000);
  ws.addEventListener('open', () => { clearTimeout(timer); finish({ ok: true, note: 'WebSocket open 成功。ブラウザ→proxy は到達している' }); });
  ws.addEventListener('error', () => { clearTimeout(timer); finish({ ok: false, reason: 'WebSocket error' }); });
});

// (2) 本命：mysql2 を WebSocket 越しに使って MySQL からデータ取得
app.get('/api/db', async (req, res) => {
  let conn;
  try {
    conn = await connectMysql();
    const [meta] = await conn.query('SELECT NOW() AS now, VERSION() AS version, CONNECTION_ID() AS conn_id');
    const [todos] = await conn.query('SELECT id, task, done FROM todos ORDER BY id');
    res.json({
      note: 'この結果はブラウザ内の mysql2 が WebSocket トンネル経由で MySQL から取得したものです',
      path: 'NodePod(mysql2) → WebSocket → proxy → MySQL(TCP)',
      server: meta[0],
      todos,
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.stack) || e) });
  } finally {
    if (conn) { try { await conn.end(); } catch (e) {} }
  }
});

// (3) 書き込みも通るか
app.get('/api/db-insert', async (req, res) => {
  let conn;
  try {
    conn = await connectMysql();
    const task = String(req.query.task || 'ブラウザから WebSocket 経由で INSERT');
    await conn.query('INSERT INTO todos (task, done) VALUES (?, ?)', [task, 1]);
    const [cnt] = await conn.query('SELECT COUNT(*) AS count FROM todos');
    res.json({ inserted: task, count: cnt[0].count });
  } catch (e) {
    res.status(502).json({ error: String((e && e.stack) || e) });
  } finally {
    if (conn) { try { await conn.end(); } catch (e) {} }
  }
});

// (debug) Buffer の read 系 / slice / toString が正しいか（行 parse はこれらに依存）
app.get('/api/buf-check', (req, res) => {
  try {
    const b = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff]);
    res.json({
      readUInt8_0: b.readUInt8(0),               // 1
      readUInt16LE_0: b.readUInt16LE(0),         // 513
      readUInt32LE_0: b.readUInt32LE(0),         // 67305985
      readUIntLE_0_3: b.readUIntLE(0, 3),        // 197121
      slice_1_3: Array.from(Buffer.from([1, 2, 3, 4]).slice(1, 3)), // [2,3]
      toString_utf8: Buffer.from([0xe3, 0x81, 0x82, 0x78]).toString('utf8'), // "あx"
      toString_range: Buffer.from('hello').toString('utf8', 1, 4), // "ell"
    });
  } catch (e) {
    res.status(500).json({ message: String(e && e.message), stack: String(e && e.stack) });
  }
});

// (debug) crypto の SHA1/SHA256 が正しいか（認証スクランブルは SHA1 ベース）
app.get('/api/crypto-check', (req, res) => {
  try {
    const crypto = require('crypto');
    const sha1 = crypto.createHash('sha1').update('test').digest('hex');
    const sha256 = crypto.createHash('sha256').update('test').digest('hex');
    res.json({
      sha1, sha1_ok: sha1 === 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
      sha256, sha256_ok: sha256 === '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    });
  } catch (e) {
    res.status(500).json({ message: String(e && e.message), stack: String(e && e.stack) });
  }
});

// (debug) 数値 param の prepared(execute) 失敗の生スタックを取得する
app.get('/api/prep-debug', (req, res) => {
  const m = require('mysql2');
  let sent = false;
  const reply = (o) => { if (sent) return; sent = true; res.json(o); };
  const c = m.createConnection({
    user: 'demo', password: 'demopass', database: 'demodb', charset: 'utf8mb4',
    stream: () => createWebSocketStream(WS_URL),
  });
  c.on('error', () => {});
  c.connect((err) => {
    if (err) return reply({ phase: 'connect', message: String(err && err.message) });
    c.execute('SELECT ? + ? AS s', [2, 3], (qerr, rows) => {
      if (qerr) return reply({ ok: false, message: String(qerr && qerr.message), stack: String(qerr && qerr.stack) });
      try { c.end(); } catch (e) {}
      reply({ ok: true, rows });
    });
  });
  setTimeout(() => reply({ phase: 'timeout' }), 10000);
});

// (debug) callback 版 mysql2 で「接続ハンドシェイク中の生スタック」を取得する
app.get('/api/db-debug', (req, res) => {
  const m = require('mysql2');
  let sent = false;
  const reply = (obj) => { if (sent) return; sent = true; res.json(obj); };
  let c;
  try {
    c = m.createConnection({
      user: 'demo', password: 'demopass', database: 'demodb', charset: 'utf8mb4',
      stream: () => createWebSocketStream(WS_URL),
    });
  } catch (e) {
    return reply({ phase: 'createConnection-sync', message: String(e && e.message), stack: String(e && e.stack) });
  }
  c.on('error', (e) => reply({ phase: 'error-event', message: String(e && e.message), stack: String(e && e.stack) }));
  c.connect((err) => {
    if (err) return reply({ phase: 'connect-cb', message: String(err && err.message), stack: String(err && err.stack) });
    c.query('SELECT 1 AS x', (qerr, rows) => {
      if (qerr) return reply({ phase: 'query', message: String(qerr && qerr.message), stack: String(qerr && qerr.stack) });
      try { c.end(); } catch (e2) {}
      reply({ ok: true, rows });
    });
  });
  setTimeout(() => reply({ phase: 'timeout', message: '10s 無応答' }), 10000);
});

// (5) 応用：トランザクション / JSON 型 / prepared statement がブラウザ内 mysql2 で通るか
app.get('/api/db-advanced', async (req, res) => {
  let conn;
  const report = {};
  try {
    conn = await connectMysql();

    // --- JSON 型カラム ---
    await conn.query('CREATE TABLE IF NOT EXISTS profiles (id INT AUTO_INCREMENT PRIMARY KEY, data JSON)');
    await conn.query('DELETE FROM profiles');
    const payload = { name: '野口', tags: ['wasm', 'mysql'], nested: { ok: true, n: 42 } };
    // prepared statement(execute) + JSON 値のバインド
    await conn.execute('INSERT INTO profiles (data) VALUES (?)', [JSON.stringify(payload)]);
    const [jrows] = await conn.execute(
      "SELECT id, data, JSON_EXTRACT(data, '$.nested.n') AS n FROM profiles",
    );
    report.json = { stored: jrows[0].data, extracted_n: jrows[0].n };

    // --- トランザクション（commit）---
    await conn.beginTransaction();
    await conn.query("INSERT INTO todos (task, done) VALUES ('TX commit されるべき', 1)");
    await conn.commit();
    const [c1] = await conn.query("SELECT COUNT(*) AS c FROM todos WHERE task='TX commit されるべき'");
    report.tx_commit = { rows_after_commit: c1[0].c };

    // --- トランザクション（rollback）---
    await conn.beginTransaction();
    await conn.query("INSERT INTO todos (task, done) VALUES ('TX rollback されるべき', 1)");
    await conn.rollback();
    const [c2] = await conn.query("SELECT COUNT(*) AS c FROM todos WHERE task='TX rollback されるべき'");
    report.tx_rollback = { rows_after_rollback: c2[0].c }; // 0 になるはず

    // --- prepared statement（execute / 数値・文字列パラメータ両方）---
    // 数値 param は DOUBLE として writeDoubleLE され NodePod のバグを踏むが、
    // Buffer.prototype.writeDoubleLE を差し替え済みなので数値パラメータも通る。
    const [p] = await conn.execute(
      'SELECT ? + ? AS sum, CONCAT(?, ?) AS joined, UPPER(?) AS up',
      [2, 3, 'Web', 'Socket', 'hello'],
    );
    report.prepared = p[0];

    res.json({ ok: true, report });
  } catch (e) {
    res.status(502).json({ error: String((e && e.stack) || e), report });
  } finally {
    if (conn) { try { await conn.end(); } catch (e) {} }
  }
});

// (4) iframe プレビュー用の HTML を配信
const page = fs.readFileSync('/www/index.html', 'utf8');
app.get('/', (req, res) => res.type('html').send(page));

app.listen(PORT, () => {
  console.log('[express] listening on port ' + PORT + '  (Node ' + process.version + ')');
});
`;

// ws-stream.js も仮想 FS に置く（server.js から require される）
export const wsStream = wsStreamJs;

// 仮想 FS 上の /www/index.html（iframe の中に表示されるミニアプリ）
export const vmIndexHtml = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>In-browser mysql2 over WebSocket</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    p.sub { margin: 0 0 16px; color: #94a3b8; font-size: 12px; }
    button { background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 8px 12px; margin: 0 6px 8px 0; cursor: pointer; font-size: 13px; }
    pre { background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-word; min-height: 60px; }
    .tag { display:inline-block; background:#166534; color:#dcfce7; font-size:11px; padding:2px 8px; border-radius:999px; }
  </style>
</head>
<body>
  <span class="tag">この画面のデータは、ブラウザ内の mysql2 が WebSocket 越しに本物の MySQL から取得しています</span>
  <h1>🐬 In-browser mysql2 over WebSocket</h1>
  <p class="sub">ブラウザのタブ内で動く Express + mysql2 が、WebSocket トンネル経由で Docker の MySQL に接続します。</p>
  <div>
    <button onclick="hit('/api/db')">/api/db（DB取得）</button>
    <button onclick="hit('/api/db-insert')">/api/db-insert（書込）</button>
    <button onclick="hit('/api/db-advanced')">/api/db-advanced（TX/JSON/prepared）</button>
  </div>
  <pre id="out">ここに結果が表示されます…</pre>
  <script>
    async function hit(path) {
      const out = document.getElementById('out');
      out.textContent = 'GET ' + path + ' …';
      try {
        const r = await fetch(path);
        const text = await r.text();
        let body = text;
        try { body = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
        out.textContent = 'GET ' + path + '  →  HTTP ' + r.status + '\\n\\n' + body;
      } catch (e) {
        out.textContent = 'GET ' + path + '  →  失敗: ' + (e && e.message || e);
      }
    }
  </script>
</body>
</html>`;
