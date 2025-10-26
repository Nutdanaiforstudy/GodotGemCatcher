/**
 * server.js
 *
 * Complete, ready-to-run WebSocket + HTTP server compatible with the provided Godot client.
 *
 * - Matches the message shapes your Godot client expects:
 *     - hello / hello_ack with name
 *     - host_request/join with playerId / name
 *     - host_response / join_response return players array
 *     - gem_spawn (server -> clients) includes 'speed' field
 *     - speed_update (server -> clients) uses { type: 'speed_update', speed: <float>, nextIncreaseThreshold: <int> }
 *     - score_update (server -> clients) uses { type: 'score_update', player: <name>, score: <int> }
 *     - caught/missed accepted from client: either with { name } field or by ws association
 * - Per-room progression: baseSpeed starts at 110, each room picks randomized thresholds in [20,35],
 *   when threshold reached baseSpeed += 1, room notifies clients with speed_update.
 * - Heartbeat, admin endpoints, safety caps, graceful shutdown.
 *
 * Usage:
 *   PORT=8080 ADMIN_TOKEN=admintoken node server.js
 */

const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// ---------- Configuration ----------
const PORT = parseInt(process.env.PORT || '8080', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

const INITIAL_BASE_SPEED = parseFloat(process.env.INITIAL_BASE_SPEED || '110'); // px/s, matches client expectation
const PROGRESSION_MIN = parseInt(process.env.PROGRESSION_MIN || '20', 10);
const PROGRESSION_MAX = parseInt(process.env.PROGRESSION_MAX || '35', 10);

const MAX_SPAWN_SPEED = parseFloat(process.env.MAX_SPAWN_SPEED || '10000');
const MAX_GEM_COUNT = parseInt(process.env.MAX_GEM_COUNT || '200000', 10);
const MAX_PLAYERS_PER_ROOM = parseInt(process.env.MAX_PLAYERS_PER_ROOM || '6', 10);

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10);
const ROOM_INACTIVITY_TTL_MS = parseInt(process.env.ROOM_INACTIVITY_TTL_MS || '300000', 10); // 5min

// ---------- In-memory state ----------
const rooms = new Map(); // roomId -> room object
const leaderboard = [];  // { name, score }

// ---------- Helpers ----------
function genRoomId() {
  return (Math.floor(Math.random() * 9000) + 1000).toString();
}
function randHex(len = 4) { return crypto.randomBytes(len).toString('hex'); }
function randBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function nowMs() { return Date.now(); }

// ---------- HTTP endpoints ----------
app.get('/', (req, res) => res.send('Gem-catcher server running.'));
app.get('/_health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));

app.get('/leaderboard', (req, res) => res.json(leaderboard.slice(0, 50)));
app.post('/leaderboard', (req, res) => {
  const { name, score } = req.body;
  if (!name || typeof score !== 'number') return res.status(400).json({ error: 'invalid' });
  leaderboard.push({ name, score });
  leaderboard.sort((a, b) => b.score - a.score);
  res.json({ ok: true });
});

// Admin middleware
function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    const token = req.get('x-admin-token') || req.query.admin_token;
    if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    return next();
  } else {
    const ip = req.ip || req.connection.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('::1');
    if (isLocal) return next();
    return res.status(403).json({ error: 'admin access restricted (set ADMIN_TOKEN to enable remote admin)' });
  }
}

app.get('/admin/rooms', requireAdmin, (req, res) => {
  const out = {};
  for (const [id, r] of rooms.entries()) {
    out[id] = {
      players: Array.from(r.players.values()),
      clientsCount: r.clients.size,
      hostId: r.hostId,
      running: !!r.running,
      gemSeq: r.gemSeq || 0,
      gemCount: r.gemCount || 0,
      baseSpeed: r.baseSpeed || 0,
      nextIncreaseThreshold: r.nextIncreaseThreshold || 0,
      gemSinceLastIncrease: r.gemSinceLastIncrease || 0,
      lastActivityMs: r.lastActivityMs || 0
    };
  }
  res.json(out);
});

app.post('/admin/terminate/:roomId', requireAdmin, (req, res) => {
  const roomId = req.params.roomId;
  if (terminateRoom(roomId, 'admin_terminate')) res.json({ ok: true, room: roomId });
  else res.status(404).json({ ok: false, error: 'room not found' });
});

app.post('/admin/terminate-all', requireAdmin, (req, res) => {
  const ids = Array.from(rooms.keys());
  ids.forEach(id => terminateRoom(id, 'admin_terminate_all'));
  res.json({ ok: true, terminated: ids.length });
});

// ---------- HTTP server + WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// upgrade handler
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Broadcast to all clients in a room except optionally the sender
function broadcastRoom(room, payload, exceptWs = null) {
  let s;
  if (typeof payload === 'string') s = payload;
  else {
    try { s = JSON.stringify(payload); } catch (e) { s = JSON.stringify({ type: 'error', message: 'payload_serialize_failed' }); }
  }
  if (!room || !room.clients) return;
  for (const c of room.clients) {
    try {
      if (c && c.readyState === WebSocket.OPEN && c !== exceptWs) c.send(s);
    } catch (e) { /* ignore send errors */ }
  }
}
function findRoomByWs(ws) {
  for (const [id, room] of rooms.entries()) {
    if (room.clients && room.clients.has(ws)) return { id, room };
  }
  return null;
}

// ---------- Room termination ----------
function terminateRoom(roomId, reason = 'admin') {
  const room = rooms.get(roomId);
  if (!room) return false;

  room.running = false;

  try { broadcastRoom(room, { type: 'room_terminated', room: roomId, reason }); } catch (e) { }

  try {
    for (const c of Array.from(room.clients)) {
      try { if (c && c.readyState === WebSocket.OPEN) c.close(4000, `room_terminated:${reason}`); } catch (e) { }
    }
  } catch (e) { }

  // leaderboard best-effort
  try {
    if (room.hostId) {
      const topScore = Array.from(room.scores.entries()).reduce((acc, [k, v]) => Math.max(acc, v), 0) || room.gemCount || 0;
      leaderboard.push({ name: room.hostId, score: topScore });
      leaderboard.sort((a, b) => b.score - a.score);
    }
  } catch (e) { }

  rooms.delete(roomId);
  console.log(`Room ${roomId} terminated (${reason}).`);
  return true;
}

// ---------- Heartbeat + prune ----------
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  const now = Date.now();

  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) { }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { }
  }

  // prune inactive rooms
  for (const [id, room] of rooms.entries()) {
    const inactive = now - (room.lastActivityMs || 0) > ROOM_INACTIVITY_TTL_MS;
    if (room.clients.size === 0 || inactive) {
      console.log(`Pruning room ${id} (clients=${room.clients.size}, inactive=${inactive})`);
      terminateRoom(id, 'pruned_inactive');
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------- WebSocket connection handling ----------
wss.on('connection', (ws, req) => {
  console.log('New WS connection');
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.playerId = null;
  ws.roomId = null;

  ws.on('message', (msg) => {
    let j;
    try { j = JSON.parse(msg.toString()); } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', message: 'invalid json' })); } catch (e) {}
      return;
    }

    const now = Date.now();
    // update lastActivity for the room if known
    const curInfo = findRoomByWs(ws);
    if (curInfo && curInfo.room) curInfo.room.lastActivityMs = now;

    // ---- HELLO ----
    if (j.type === 'hello') {
      const name = (typeof j.name === 'string' && j.name.length > 0) ? j.name : ('Player-' + randHex(2));
      ws.playerId = name;
      try { ws.send(JSON.stringify({ type: 'hello_ack', ok: true, name })); } catch (e) {}
      console.log(`HELLO from ${name}`);
      return;
    }

    // ---- HOST REQUEST ----
    if (j.type === 'host_request') {
      // The client may send playerId/name; prefer name if provided
      const requestedName = (typeof j.playerId === 'string' && j.playerId.length > 0) ? j.playerId :
                            (typeof j.name === 'string' && j.name.length > 0) ? j.name : ('Host-' + randHex(2));
      let roomId;
      do { roomId = genRoomId(); } while (rooms.has(roomId));

      const room = {
        id: roomId,
        clients: new Set(),
        players: new Map(), // ws -> playerName
        hostWs: ws,
        hostId: requestedName,
        gemSeq: 0,
        gemCount: 0,
        baseSpeed: INITIAL_BASE_SPEED,
        gemSinceLastIncrease: 0,
        nextIncreaseThreshold: randBetween(PROGRESSION_MIN, PROGRESSION_MAX),
        running: false,
        lastActivityMs: now,
        scores: new Map() // playerName -> score
      };

      rooms.set(roomId, room);
      room.clients.add(ws);
      room.players.set(ws, requestedName);
      room.scores.set(requestedName, 0);

      ws.playerId = requestedName;
      ws.roomId = roomId;

      try { ws.send(JSON.stringify({ type: 'host_response', ok: true, room: roomId, players: Array.from(room.players.values()), baseSpeed: room.baseSpeed, nextIncreaseThreshold: room.nextIncreaseThreshold })); } catch (e) {}
      console.log(`Room ${roomId} created by host ${requestedName}`);
      return;
    }

    // ---- JOIN ----
    if (j.type === 'join' && typeof j.room === 'string') {
      const room = rooms.get(j.room);
      if (!room) { try { ws.send(JSON.stringify({ type: 'join_response', ok: false, reason: 'room not found' })); } catch (e) {} return; }
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) { try { ws.send(JSON.stringify({ type: 'join_response', ok: false, reason: 'room full' })); } catch (e) {} return; }

      // choose a player name: prefer provided playerId/name; ensure uniqueness in room
      let provided = (typeof j.playerId === 'string' && j.playerId.length > 0) ? j.playerId :
                     (typeof j.name === 'string' && j.name.length > 0) ? j.name : ('P-' + randHex(2));
      const existing = new Set(Array.from(room.players.values()));
      let playerName = provided;
      if (existing.has(playerName)) playerName = `${playerName}-${randHex(1)}`;

      room.clients.add(ws);
      room.players.set(ws, playerName);
      room.scores.set(playerName, 0);
      ws.playerId = playerName;
      ws.roomId = j.room;
      room.lastActivityMs = now;

      try {
        ws.send(JSON.stringify({ type: 'join_response', ok: true, room: j.room, players: Array.from(room.players.values()), baseSpeed: room.baseSpeed, nextIncreaseThreshold: room.nextIncreaseThreshold }));
        broadcastRoom(room, { type: 'player_joined', playerId: playerName }, ws);
      } catch (e) {}
      console.log(`Player ${playerName} joined room ${j.room}`);
      return;
    }

    // ---- START (host only) ----
    if (j.type === 'start' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'error', message: 'room missing' })); } catch (e) {} return; }
      if (room.hostWs !== ws) { try { ws.send(JSON.stringify({ type: 'error', message: 'not host' })); } catch (e) {} return; }
      if (room.running) { try { ws.send(JSON.stringify({ type: 'error', message: 'already running' })); } catch (e) {} return; }

      room.running = true;
      room.gemSeq = 0;
      room.gemCount = 0;
      room.gemSinceLastIncrease = 0;
      room.baseSpeed = INITIAL_BASE_SPEED;
      room.nextIncreaseThreshold = randBetween(PROGRESSION_MIN, PROGRESSION_MAX);
      for (const p of room.players.values()) room.scores.set(p, 0);
      room.lastActivityMs = now;

      broadcastRoom(room, { type: 'start', room: ws.roomId, seed: now, players: Array.from(room.players.values()), baseSpeed: room.baseSpeed, nextIncreaseThreshold: room.nextIncreaseThreshold });
      console.log(`Match started in room ${ws.roomId}`);
      spawnLoop(room, ws.roomId).catch(err => console.error('spawnLoop error', err));
      return;
    }

    // ---- END GAME (host) ----
    if (j.type === 'end_game' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'end_ack', ok: false, reason: 'room_missing' })); } catch (e) {} return; }
      if (room.hostWs !== ws) { try { ws.send(JSON.stringify({ type: 'end_ack', ok: false, reason: 'not_host' })); } catch (e) {} return; }

      try { ws.send(JSON.stringify({ type: 'end_ack', ok: true, room: ws.roomId })); } catch (e) {}

      // optional leaderboard push
      try {
        const top = Array.from(room.scores.values()).reduce((acc, v) => Math.max(acc, v), 0) || room.gemCount || 0;
        leaderboard.push({ name: room.hostId || 'host', score: top });
        leaderboard.sort((a, b) => b.score - a.score);
      } catch (e) {}

      terminateRoom(ws.roomId, 'host_requested_end');
      return;
    }

    // ---- CAUGHT / MISSED / SCORE_UPDATE from clients ----
    // Clients (NetworkWsClients) send { type: 'caught', gemId, name } or { type: 'missed', gemId, name } or score_update
    if ((j.type === 'caught' || j.type === 'missed' || j.type === 'score_update') && ws) {
      // Determine player name: prefer j.name (Godot sends name) else ws.playerId
      const playerName = (typeof j.name === 'string' && j.name.length > 0) ? j.name : ws.playerId;
      const info = findRoomByWs(ws);
      if (!info) {
        // No room context. If message included room / name but not socket association, try to find the room by playerName
        let found = null;
        for (const [rid, r] of rooms.entries()) {
          if (Array.from(r.players.values()).includes(playerName)) { found = { id: rid, room: r }; break; }
        }
        if (!found) return;
        // proceed with found room
        processPlayerEvent(found.room, playerName, j);
        return;
      } else {
        processPlayerEvent(info.room, playerName, j, ws, info.id);
        return;
      }
    }

    // ---- generic relay for clients in room ----
    if (ws.roomId) {
      const info = findRoomByWs(ws);
      if (!info) { try { ws.send(JSON.stringify({ type: 'error', message: 'not joined' })); } catch (e) {} return; }
      broadcastRoom(info.room, j, ws);
      return;
    }

    // fallback unknown message
    try { ws.send(JSON.stringify({ type: 'error', message: 'not joined or unsupported message type' })); } catch (e) {}
  }); // end message handler

  ws.on('close', () => {
    const info = findRoomByWs(ws);
    if (info) {
      const { id, room } = info;
      const pid = room.players.get(ws);
      room.players.delete(ws);
      room.clients.delete(ws);
      // keep scores for summary, but remove mapping
      broadcastRoom(room, { type: 'player_left', playerId: pid, scores: Object.fromEntries(room.scores) });
      console.log(`Connection closed: ${pid} left room ${id}`);

      if (room.clients.size === 0) {
        rooms.delete(id);
        console.log(`Deleted empty room ${id}`);
      } else if (room.hostWs === ws) {
        // pick new host
        const newHostWs = room.clients.values().next().value;
        room.hostWs = newHostWs;
        room.hostId = room.players.get(newHostWs) || room.hostId;
        broadcastRoom(room, { type: 'host_changed', newHost: room.hostId, players: Array.from(room.players.values()) });
        console.log(`Host for room ${id} changed to ${room.hostId}`);
      }
    }
  });

  ws.on('error', (err) => console.warn('WS error', err && err.message ? err.message : err));
});

// ---------- process player event helper ----------
function processPlayerEvent(room, playerName, j, ws = null, roomId = null) {
  // j.type is 'caught' | 'missed' | 'score_update'
  if (!room) return;

  if (j.type === 'score_update') {
    const score = (typeof j.score === 'number') ? j.score : room.scores.get(playerName) || 0;
    room.scores.set(playerName, score);
    broadcastRoom(room, { type: 'score_update', player: playerName, score });
    return;
  }

  if (j.type === 'caught') {
    // optional points
    const points = (typeof j.points === 'number') ? j.points : 1;
    const prev = room.scores.get(playerName) || 0;
    const newScore = prev + points;
    room.scores.set(playerName, newScore);

    broadcastRoom(room, { type: 'player_caught', playerId: playerName, gemId: j.gemId || '', points, scores: Object.fromEntries(room.scores) });
    broadcastRoom(room, { type: 'score_update', player: playerName, score: newScore });

    // Nothing else (server doesn't eliminate on caught)
    return;
  }

  if (j.type === 'missed') {
    // eliminate player: remove from players map and clients set (if ws provided)
    // find ws entry for this player
    let wsToRemove = null;
    for (const [s, name] of room.players.entries()) {
      if (name === playerName) { wsToRemove = s; break; }
    }

    if (wsToRemove) {
      room.players.delete(wsToRemove);
      room.clients.delete(wsToRemove);
    } else {
      // if no ws found, try to remove by playerName from players map
      for (const [s, name] of room.players.entries()) {
        if (name === playerName) {
          room.players.delete(s);
          room.clients.delete(s);
          break;
        }
      }
    }

    const playerScore = room.scores.get(playerName) || 0;
    room.scores.delete(playerName);

    broadcastRoom(room, { type: 'player_eliminated', playerId: playerName, score: playerScore });

    console.log(`Player ${playerName} eliminated in room ${room.id || roomId}`);

    // Check for match end
    if (room.players.size === 1) {
      const winner = Array.from(room.players.values())[0];
      const scoresObj = Object.fromEntries(room.scores);
      broadcastRoom(room, { type: 'match_over', winner, scores: scoresObj });
      // update leaderboard
      try {
        const top = Math.max(...Object.values(scoresObj).map(v => Number(v)), 0) || room.gemCount || 0;
        leaderboard.push({ name: winner, score: top });
        leaderboard.sort((a, b) => b.score - a.score);
      } catch (e) { }
      room.running = false;
      terminateRoom(room.id || roomId, 'match_over');
    } else {
      // if room became empty
      if (room.clients.size === 0) {
        rooms.delete(room.id || roomId);
        console.log(`Deleted empty room ${room.id || roomId}`);
      }
    }

    return;
  }
}

// ---------- spawn loop (authoritative) ----------
async function spawnLoop(room, roomId) {
  try {
    if (!room || !room.running) return;

    // choose interval based on baseSpeed (tuned so players still have reaction time)
    const baseIntervalMs = 1000;
    const intervalMs = Math.max(150, Math.floor(baseIntervalMs / (1 + (room.baseSpeed - INITIAL_BASE_SPEED) / 200)));

    await new Promise(resolve => setTimeout(resolve, intervalMs));

    // re-check room
    const currentRoom = rooms.get(roomId);
    if (!currentRoom || !currentRoom.running) return;

    currentRoom.gemSeq = (currentRoom.gemSeq || 0) + 1;
    currentRoom.gemCount = (currentRoom.gemCount || 0) + 1;
    currentRoom.gemSinceLastIncrease = (currentRoom.gemSinceLastIncrease || 0) + 1;
    currentRoom.lastActivityMs = Date.now();

    if (currentRoom.gemCount > MAX_GEM_COUNT) {
      console.warn(`Room ${roomId} exceeded MAX_GEM_COUNT (${currentRoom.gemCount}) -> terminating.`);
      terminateRoom(roomId, 'max_gem_count');
      return;
    }

    const gemId = 'g' + currentRoom.gemSeq;
    const worldWidth = 800; // suggestion for clients
    const x = Math.floor(Math.random() * worldWidth);
    const speed = Math.min(MAX_SPAWN_SPEED, currentRoom.baseSpeed);

    // send spawn (include 'special' optionally as random 10%)
    const special = (Math.random() < 0.1);
    broadcastRoom(currentRoom, { type: 'gem_spawn', room: roomId, gemId, x, speed, seq: currentRoom.gemSeq, time: Date.now(), special });

    // progression: when gemSinceLastIncrease reaches threshold, increment baseSpeed and reset
    if (currentRoom.gemSinceLastIncrease >= currentRoom.nextIncreaseThreshold) {
      currentRoom.baseSpeed = Math.min(MAX_SPAWN_SPEED, currentRoom.baseSpeed + 1);
      currentRoom.gemSinceLastIncrease = 0;
      currentRoom.nextIncreaseThreshold = randBetween(PROGRESSION_MIN, PROGRESSION_MAX);
      broadcastRoom(currentRoom, { type: 'speed_update', speed: currentRoom.baseSpeed, nextIncreaseThreshold: currentRoom.nextIncreaseThreshold });
      console.log(`Room ${roomId}: baseSpeed -> ${currentRoom.baseSpeed} nextThreshold=${currentRoom.nextIncreaseThreshold}`);

      if (currentRoom.baseSpeed >= MAX_SPAWN_SPEED) {
        console.warn(`Room ${roomId} reached MAX_SPAWN_SPEED (${MAX_SPAWN_SPEED}) -> terminating.`);
        terminateRoom(roomId, 'max_spawn_speed');
        return;
      }
    }

    // continue loop
    return spawnLoop(currentRoom, roomId);
  } catch (err) {
    console.error('spawnLoop caught', err && err.stack ? err.stack : err);
  }
}

// ---------- graceful shutdown ----------
function gracefulShutdown() {
  console.log('Graceful shutdown initiated...');
  for (const id of Array.from(rooms.keys())) terminateRoom(id, 'server_shutdown');
  try {
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => { console.warn('Forcing exit.'); process.exit(0); }, 5000);
  } catch (e) { console.error('Shutdown error', e); process.exit(1); }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ---------- start ----------
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
