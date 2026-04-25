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

// ===== 公開ルーム一覧を全クライアントに配信 =====
function broadcastPublicRooms() {
  const list = Object.entries(rooms)
    .filter(([id, room]) => room.public && (!room.hero || !room.demon))
    .map(([id, room]) => ({
      roomId: id,
      waitingRole: room.hero ? 'hero' : 'demon', // 待っている側のロール
      hostName: room.hostName || '匿名',
    }));
  const msg = JSON.stringify({ type: 'public_rooms', rooms: list });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ===== WebSocket 接続 =====
wss.on('connection', (ws) => {
  console.log('クライアント接続');
  ws.roomId = null;
  ws.role   = null;
  // 接続時に現在の公開ルーム一覧を送る
  const list = Object.entries(rooms)
    .filter(([id, room]) => room.public && (!room.hero || !room.demon))
    .map(([id, room]) => ({
      roomId: id,
      waitingRole: room.hero ? 'hero' : 'demon',
      hostName: room.hostName || '匿名',
    }));
  ws.send(JSON.stringify({ type: 'public_rooms', rooms: list }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- ルーム作成（ロール指定あり・公開フラグあり） ----
    if (msg.type === 'create_room') {
      const role     = msg.role === 'demon' ? 'demon' : 'hero';
      const isPublic = msg.public === true;
      const hostName = (msg.hostName || '').slice(0, 12) || '匿名';
      let id;
      do { id = makeRoomId(); } while (rooms[id]);
      rooms[id] = {
        hero:     role === 'hero'  ? ws : null,
        demon:    role === 'demon' ? ws : null,
        state:    null,
        public:   isPublic,
        hostName: hostName,
      };
      ws.roomId = id;
      ws.role   = role;
      ws.send(JSON.stringify({ type: 'room_created', roomId: id, role, public: isPublic }));
      console.log(`ルーム作成: ${id} (${role}) public:${isPublic}`);
      // 公開ルームなら全員に通知
      if (isPublic) broadcastPublicRooms();
    }

    // ---- ルーム参加（空きスロットに入る） ----
    else if (msg.type === 'join_room') {
      const id = (msg.roomId || '').toUpperCase();
      const room = rooms[id];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません: ' + id }));
        return;
      }
      // 空きスロットを探す
      let joinRole = null;
      if (!room.hero)  joinRole = 'hero';
      else if (!room.demon) joinRole = 'demon';
      if (!joinRole) {
        ws.send(JSON.stringify({ type: 'error', message: 'このルームは満員です' }));
        return;
      }
      room[joinRole] = ws;
      ws.roomId = id;
      ws.role   = joinRole;
      console.log(`ルーム参加: ${id} (${joinRole})`);
      // 両者にゲーム開始を通知
      room.hero.send(JSON.stringify({ type: 'game_start', yourRole: 'hero' }));
      room.demon.send(JSON.stringify({ type: 'game_start', yourRole: 'demon' }));
      // 公開ルームなら一覧を更新（満員になったので消える）
      if (room.public) broadcastPublicRooms();
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
    const wasPublic = room.public;
    delete rooms[ws.roomId];
    console.log(`ルーム削除: ${ws.roomId}`);
    // 公開ルームだったら一覧を更新
    if (wasPublic) broadcastPublicRooms();
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
