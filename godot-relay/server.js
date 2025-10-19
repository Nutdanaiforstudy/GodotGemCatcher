// server.js
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ noServer: true });

// In-memory rooms: { roomId: Set of ws clients }
const rooms = new Map();
// Simple in-memory leaderboard
const leaderboard = []; // { name, score }

// Root page — useful so browsing your URL shows something
app.get('/', (req, res) => {
  res.send('WebSocket relay is running.');
});

// Health endpoint
app.get('/_health', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Leaderboard endpoints
app.get('/leaderboard', (req, res) => {
  res.json(leaderboard.slice(0, 50));
});
app.post('/leaderboard', (req, res) => {
  const { name, score } = req.body;
  if (!name || typeof score !== 'number') return res.status(400).json({ error: 'invalid' });
  leaderboard.push({ name, score });
  leaderboard.sort((a, b) => b.score - a.score);
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
});

// Upgrade handler for WebSocket handshake
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

function broadcastToRoom(roomId, sender, data) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const client of set) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws, req) => {
  console.log('New WS connection from', req.socket.remoteAddress || req.headers['x-forwarded-for']);
  let joinedRoom = null;
  let playerId = null;

  ws.on('message', (msg) => {
    let j = null;
    try { j = JSON.parse(msg.toString()); }
    catch (e) {
      console.warn('Invalid JSON', e);
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }

    if (j.type === 'join' && typeof j.room === 'string') {
      joinedRoom = j.room;
      playerId = j.playerId || null;
      if (!rooms.has(joinedRoom)) rooms.set(joinedRoom, new Set());
      rooms.get(joinedRoom).add(ws);
      console.log(`Player joined room ${joinedRoom} id=${playerId}`);
      broadcastToRoom(joinedRoom, ws, JSON.stringify({ type: 'player_joined', playerId }));
      return;
    }

    if (!joinedRoom) {
      ws.send(JSON.stringify({ type: 'error', message: 'not joined' }));
      return;
    }

    if (j.type && joinedRoom) {
      if (!j.playerId && playerId) j.playerId = playerId;
      const out = JSON.stringify(j);
      broadcastToRoom(joinedRoom, ws, out);
    }
  });

  ws.on('close', () => {
    console.log('WS closed', joinedRoom, playerId);
    if (joinedRoom) {
      const set = rooms.get(joinedRoom);
      if (set) {
        set.delete(ws);
        if (set.size === 0) rooms.delete(joinedRoom);
        else broadcastToRoom(joinedRoom, ws, JSON.stringify({ type: 'player_left', playerId }));
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('WS error', err && err.message ? err.message : err);
  });
});
