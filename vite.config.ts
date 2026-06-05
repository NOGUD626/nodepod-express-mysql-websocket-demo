import { defineConfig } from 'vite';
import nodepod from '@scelar/nodepod/vite';

// nodepod() プラグインが /__sw__.js を同一オリジンで配信する。
// （ブラウザは node_modules から Service Worker を登録できないため必須）
//
// 補足: もし SharedArrayBuffer 系機能（execSync / 一部の WASI モジュール）を
// 使いたい場合は、以下のように Cross-Origin Isolation ヘッダーを付ける。
// 本デモは enableSharedArrayBuffer:false で動かすので不要だが、参考まで残す。
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
  },
};

export default defineConfig({
  plugins: [
    nodepod(),
    // crossOriginIsolation, // ← SAB を有効化したい場合のみコメントアウトを外す
  ],
  server: {
    port: 5173,
  },
});
