-- 初期化スクリプトを UTF-8 として解釈させる。
-- これが無いと公式イメージの mysql クライアントが latin1 で読み込み、
-- 日本語が二重エンコードされて保存される（mojibake の原因）。
SET NAMES utf8mb4;

USE demodb;

CREATE TABLE IF NOT EXISTS todos (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  task VARCHAR(255) NOT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0
);

INSERT INTO todos (task, done) VALUES
  ('ブラウザ内 NodePod から WebSocket 経由で MySQL に接続する', 1),
  ('WASM な Node.js でも mysql2 は動くのか確かめる', 1),
  ('ブラウザのタブだけで本物の DB に繋ぐ', 1),
  ('ビールを飲む', 0);
