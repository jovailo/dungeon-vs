const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// public フォルダの中身をそのまま配信する
app.use(express.static(path.join(__dirname, 'public')));

// ===== ルーム管理 =====
// rooms = { "ABC123": { hero: ws, demon: ws, state: {...} } }
const rooms = {};

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  if (room.hero  && room.hero.readyState  === 1) room.hero.send(data);
  if (room.demon && room.demon.readyState === 1) room.demon.send(data);
}

// ===== WebSocket 接続 =====
wss.on('connection', (ws) => {
  console.log('クライアント接続');
  ws.roomId = null;
  ws.role   = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- ルーム作成（勇者側） ----
    if (msg.type === 'create_room') {
      let id;
      do { id = makeRoomId(); } while (rooms[id]);
      rooms[id] = { hero: ws, demon: null, state: null };
      ws.roomId = id;
      ws.role   = 'hero';
      ws.send(JSON.stringify({ type: 'room_created', roomId: id }));
      console.log(`ルーム作成: ${id}`);
    }

    // ---- ルーム参加（魔王側） ----
    else if (msg.type === 'join_room') {
      const id = (msg.roomId || '').toUpperCase();
      const room = rooms[id];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません: ' + id }));
        return;
      }
      if (room.demon) {
        ws.send(JSON.stringify({ type: 'error', message: 'このルームは満員です' }));
        return;
      }
      room.demon = ws;
      ws.roomId  = id;
      ws.role    = 'demon';
      console.log(`ルーム参加: ${id}`);
      // 両者にゲーム開始を通知
      broadcast(room, { type: 'game_start', heroRole: 'hero', demonRole: 'demon' });
    }

    // ---- ゲームの操作をもう一方に転送 ----
    // hero_action / demon_action / state_sync など
    else if (msg.type === 'hero_action' || msg.type === 'demon_action' || msg.type === 'state_sync') {
      const room = rooms[ws.roomId];
      if (!room) return;
      // 送信者以外に転送する
      const target = ws.role === 'hero' ? room.demon : room.hero;
      if (target && target.readyState === 1) {
        target.send(JSON.stringify(msg));
      }
    }

    // ---- チャットメッセージ ----
    else if (msg.type === 'chat') {
      const room = rooms[ws.roomId];
      if (!room) return;
      broadcast(room, { type: 'chat', role: ws.role, text: msg.text });
    }
  });

  ws.on('close', () => {
    const room = rooms[ws.roomId];
    if (!room) return;
    // 相手に切断を通知
    const other = ws.role === 'hero' ? room.demon : room.hero;
    if (other && other.readyState === 1) {
      other.send(JSON.stringify({ type: 'opponent_disconnected' }));
    }
    // ルームを削除
    delete rooms[ws.roomId];
    console.log(`ルーム削除: ${ws.roomId}`);
  });
});

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log(`  DUNGEON VS サーバー起動中`);
  console.log(`  ポート: ${PORT}`);
  console.log('');
  console.log('  【このPCでプレイ】');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  【同じWiFiの別端末でプレイ（ローカル）】');
  console.log('  コマンドプロンプトで ipconfig を実行し');
  console.log(`  IPv4アドレス:${PORT} にアクセス`);
  console.log('');
  console.log('  【Renderで公開中の場合】');
  console.log('  RenderのダッシュボードでURLを確認してください');
  console.log('========================================');
  console.log('');
});
