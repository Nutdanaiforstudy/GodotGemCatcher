// server.js
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ noServer: true });

// Rooms: Map<roomId, roomObj>
const rooms = new Map();
// Leaderboard
const leaderboard = [];

// HTTP helpers
app.get('/', (req, res) => res.send('WebSocket relay is running.'));
app.get('/_health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));
app.get('/leaderboard', (req, res) => res.json(leaderboard.slice(0, 50)));
app.post('/leaderboard', (req, res) => {
  const { name, score } = req.body;
  if (!name || typeof score !== 'number') return res.status(400).json({ error: 'invalid' });
  leaderboard.push({ name, score });
  leaderboard.sort((a, b) => b.score - a.score);
  res.json({ ok: true });
});

const server = app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

// upgrade for websocket
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// helper: generate 4-digit room id
function genRoomId() {
  return (Math.floor(Math.random() * 9000) + 1000).toString();
}

function broadcastRoom(room, payload, exceptWs = null) {
  const s = JSON.stringify(payload);
  for (const c of room.clients) {
    if (c.readyState === WebSocket.OPEN && c !== exceptWs) c.send(s);
  }
}

function findRoomByWs(ws) {
  for (const [id, room] of rooms.entries()) {
    if (room.clients.has(ws)) return { id, room };
  }
  return null;
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('New WS connection from', req.socket.remoteAddress || req.headers['x-forwarded-for']);
  ws.playerId = null;
  ws.roomId = null;

  ws.on('message', (msg) => {
    let j;
    try { j = JSON.parse(msg.toString()); } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }

    // ---------- Host request ----------
    if (j.type === 'host_request') {
      const playerId = j.playerId || ('Host-' + crypto.randomBytes(2).toString('hex'));
      let roomId;
      do { roomId = genRoomId(); } while (rooms.has(roomId));
      const room = {
        clients: new Set(),
        players: new Map(), // ws -> playerId
        hostWs: ws,
        hostId: playerId,
        gemSeq: 0,
        gemCount: 0,
        spawnSpeed: 1.0,
        running: false
      };
      rooms.set(roomId, room);
      room.clients.add(ws);
      room.players.set(ws, playerId);
      ws.playerId = playerId;
      ws.roomId = roomId;
      ws.send(JSON.stringify({ type: 'host_response', ok: true, room: roomId }));
      console.log(`Room ${roomId} created by ${playerId}`);
      return;
    }

    // ---------- Join ----------
    if (j.type === 'join' && typeof j.room === 'string') {
      const room = rooms.get(j.room);
      if (!room) { ws.send(JSON.stringify({ type:'join_response', ok:false, reason:'room not found' })); return; }
      if (room.clients.size >= 4) { ws.send(JSON.stringify({ type:'join_response', ok:false, reason:'room full' })); return; }
      const playerId = j.playerId || ('P' + crypto.randomBytes(2).toString('hex'));
      room.clients.add(ws);
      room.players.set(ws, playerId);
      ws.playerId = playerId;
      ws.roomId = j.room;
      ws.send(JSON.stringify({ type:'join_response', ok:true, room:j.room, players: Array.from(room.players.values()) }));
      broadcastRoom(room, { type:'player_joined', playerId });
      console.log(`Player ${playerId} joined ${j.room}`);
      return;
    }

    // ---------- Start (host only) ----------
    if (j.type === 'start' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) { ws.send(JSON.stringify({ type:'error', message:'room missing' })); return; }
      if (room.hostWs !== ws) { ws.send(JSON.stringify({ type:'error', message:'not host' })); return; }
      if (room.running) { ws.send(JSON.stringify({ type:'error', message:'already running' })); return; }
      room.running = true;
      room.gemSeq = 0;
      room.gemCount = 0;
      room.spawnSpeed = 1.0;
      broadcastRoom(room, { type:'start', room: ws.roomId, seed: Date.now() });
      spawnLoop(room, ws.roomId);
      console.log(`Match started in ${ws.roomId}`);
      return;
    }

    // ---------- caught / missed ----------
    if ((j.type === 'caught' || j.type === 'missed') && ws.roomId) {
      const info = findRoomByWs(ws);
      if (!info) return;
      const room = info.room;
      const pid = ws.playerId;
      if (j.type === 'missed') {
        // eliminate player immediately (simple rule)
        room.players.delete(ws);
        room.clients.delete(ws);
        broadcastRoom(room, { type:'player_eliminated', playerId: pid });
        console.log(`Player eliminated ${pid} in room ${info.id}`);
        if (room.players.size === 1) {
          const winner = Array.from(room.players.values())[0];
          broadcastRoom(room, { type:'match_over', winner });
          room.running = false;
          console.log(`Match over in ${info.id}, winner ${winner}`);
        }
        if (room.clients.size === 0) rooms.delete(info.id);
      } else if (j.type === 'caught') {
        // broadcast caught so other clients can update UI
        broadcastRoom(room, { type:'player_caught', playerId: pid, gemId: j.gemId });
      }
      return;
    }

    // ---------- fallback relay for joined rooms ----------
    if (ws.roomId) {
      const info = findRoomByWs(ws);
      if (!info) { ws.send(JSON.stringify({ type:'error', message:'not joined' })); return; }
      // relay other messages to the room
      const out = JSON.stringify(j);
      broadcastRoom(info.room, out, ws);
    } else {
      ws.send(JSON.stringify({ type:'error', message:'not joined' }));
    }
  }); // end message

  ws.on('close', () => {
    const info = findRoomByWs(ws);
    if (info) {
      const { id, room } = info;
      const pid = room.players.get(ws);
      room.players.delete(ws);
      room.clients.delete(ws);
      broadcastRoom(room, { type:'player_left', playerId: pid });
      if (room.clients.size === 0) {
        rooms.delete(id);
        console.log(`Deleted empty room ${id}`);
      } else if (room.hostWs === ws) {
        // pick new host
        const newHost = room.clients.values().next().value;
        room.hostWs = newHost;
        room.hostId = room.players.get(newHost);
        broadcastRoom(room, { type:'host_changed', newHost: room.hostId });
      }
    }
  });

  ws.on('error', (err) => console.warn('WS error', err && err.message ? err.message : err));
});

// server-side spawn loop
function spawnLoop(room, roomId) {
  if (!room.running) return;
  const baseIntervalMs = 1000;
  const intervalMs = Math.max(200, Math.floor(baseIntervalMs / room.spawnSpeed));
  setTimeout(() => {
    if (!room.running) return;
    room.gemSeq += 1;
    room.gemCount += 1;
    const gemId = 'g' + room.gemSeq;
    const x = Math.floor(Math.random() * 800); // clients should adapt world width
    const speed = room.spawnSpeed;
    broadcastRoom(room, { type:'gem_spawn', room: roomId, gemId, x, speed, seq: room.gemSeq, time: Date.now() });
    if (room.gemCount % 25 === 0) {
      room.spawnSpeed *= 1.1; // increase 10%
      broadcastRoom(room, { type:'speed_update', spawnSpeed: room.spawnSpeed });
      console.log(`Room ${roomId} speed up -> ${room.spawnSpeed}`);
    }
    spawnLoop(room, roomId);
  }, intervalMs);
}
