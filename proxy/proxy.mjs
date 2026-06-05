/**
 * WebSocket ⇄ TCP プロキシ（websockify の最小実装に相当）
 *
 * ブラウザ内 NodePod の mysql2 が開いた WebSocket を受け、
 * その中身のバイトを「本物の TCP 接続」で MySQL へ右から左へ流すだけ。
 * MySQL プロトコルのことは一切知らない＝ただの土管。
 *
 *   ブラウザ(NodePod の mysql2) ──WebSocket──▶ [proxy] ──TCP──▶ MySQL(Docker)
 */
import { WebSocketServer } from 'ws';
import net from 'node:net';

const WS_PORT = Number(process.env.WS_PORT || 8090);
const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3312); // docker-compose で publish したホスト側ポート

const wss = new WebSocketServer({ port: WS_PORT });
console.log(
  `[proxy] WebSocket↔TCP bridge up:  ws://127.0.0.1:${WS_PORT}  →  ${MYSQL_HOST}:${MYSQL_PORT}`,
);

wss.on('connection', (ws) => {
  console.log('[proxy] WS client connected → opening TCP to MySQL...');
  const tcp = net.connect(MYSQL_PORT, MYSQL_HOST);

  let wsToTcp = 0;
  let tcpToWs = 0;

  // ブラウザ側 → (WebSocket) → ここ → (TCP) → MySQL
  ws.on('message', (data) => {
    wsToTcp += data.length;
    tcp.write(data);
  });

  // MySQL → (TCP) → ここ → (WebSocket) → ブラウザ側
  tcp.on('data', (data) => {
    tcpToWs += data.length;
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ws.on('close', () => tcp.end());
  tcp.on('close', () => {
    try { ws.close(); } catch {}
    console.log(
      `[proxy] session closed.  ws→tcp ${wsToTcp}B,  tcp→ws ${tcpToWs}B  ` +
        '(↑ これが MySQL プロトコルのバイト列。土管は中身を理解せず素通し)',
    );
  });
  ws.on('error', () => tcp.destroy());
  tcp.on('error', (e) => {
    console.log('[proxy] tcp error:', e.message);
    try { ws.close(); } catch {}
  });
});
