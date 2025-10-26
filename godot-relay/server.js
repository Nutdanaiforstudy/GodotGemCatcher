/**
 * server.js
 *
 * Multiplayer relay + authoritative spawn & progression controller for Gem Catcher.
 *
 * Key changes vs. the prior version:
 *  - Per-room base gem drop speed (baseSpeed) starting at 110 px/s (client maps this directly).
 *  - Per-room randomized "increase threshold" sequence: each room picks the next threshold uniformly from [20,35].
 *    When the room's gem drop count reaches that threshold, baseSpeed += 1, gem counter for that step resets,
 *    and a new random threshold in [20,35] is chosen. This implements your requirement:
 *      "first increment is e.g. 20, so every player increases speed after 20 drops, next interval might be 30, etc."
 *  - Per-player scores tracked on the server and sent to all clients on match_over. The server accepts
 *    `caught` messages optionally with `points` (default 1) so special gems can award more.
 *  - Host remains a playable client. Host name mismatch issue is addressed by consistently using server-assigned
 *    playerIds and returning the authoritative list to clients (host kept as originally assigned).
 *  - On join/host_response we return the full players list (authoritative).
 *  - When a player misses they are removed and broadcast as eliminated. When only one remains, server sends
 *    match_over with the full scores object to all clients, then optionally terminates the room.
 *
 * Usage:
 *   NODE_ENV=production ADMIN_TOKEN=yourownsecret PORT=8080 node server.js
 *
 * Environment variables:
 *   PORT                      HTTP & WebSocket port (default 8080)
 *   ADMIN_TOKEN               Optional admin endpoint token
 *   MAX_SPAWN_SPEED           Cap on speed (default 10000)
 *   MAX_GEM_COUNT             Cap on gemCount (default 200000)
 *   MAX_PLAYERS_PER_ROOM      Default 6
 *
 * The server intentionally uses plain in-memory data structures for simplicity.
 * For production scale consider persistent stores (Redis) and horizontal scaling.
 */

const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');

const app = express();
app.use(bodyParser.json());

// Config
const PORT = parseInt(process.env.PORT || '8080', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const MAX_SPAWN_SPEED = parseFloat(process.env.MAX_SPAWN_SPEED || '10000');
const MAX_GEM_COUNT = parseInt(process.env.MAX_GEM_COUNT || '200000', 10);
const MAX_PLAYERS_PER_ROOM = parseInt(process.env.MAX_PLAYERS_PER_ROOM || '6', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10);
const ROOM_INACTIVITY_TTL_MS = parseInt(process.env.ROOM_INACTIVITY_TTL_MS || '300000', 10); // 5 min

// Helpers
function genRoomId() {
  return (Math.floor(Math.random() * 9000) + 1000).toString(); // 1000-9999
}
function randHex(len = 4) {
  return crypto.randomBytes(len).toString('hex');
}
function randBetween(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// In-memory storage
const rooms = new Map(); // roomId -> room object
const leaderboard = [];  // simple array of { name, score }

// Room initial constants matching your requirement
const INITIAL_GEM_SPEED = 110; // px/s — direct usable by client if you decide so
const PROGRESSION_MIN = 20;
const PROGRESSION_MAX = 35;

// Utility: build players array from room.players (Map<ws, playerId>) preserving insertion order
function playersListFromMap(playersMap) {
  return Array.from(playersMap.values());
}

// HTTP endpoints (health + leaderboard)
app.get('/', (req, res) => res.send('Gem catch server (WebSocket relay + spawn controller).'));
app.get('/_health', (req, res) => res.json({ ok: true, timestamp: Date.now() }));
app.get('/leaderboard', (req, res) => res.json(leaderboard.slice(0, 100)));
app.post('/leaderboard', (req, res) => {
  const { name, score } = req.body;
  if (!name || typeof score !== 'number') return res.status(400).json({ error: 'invalid' });
  leaderboard.push({ name, score });
  leaderboard.sort((a, b) => b.score - a.score);
  return res.json({ ok: true });
});

// Admin middleware
function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    const token = req.get('x-admin-token') || req.query.admin_token;
    if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    return next();
  } else {
    // restrict to localhost if no token set
    const ip = req.ip || req.connection.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('::1');
    if (isLocal) return next();
    return res.status(403).json({ error: 'admin access restricted (set ADMIN_TOKEN to enable remote admin)' });
  }
}

app.get('/admin/rooms', requireAdmin, (req, res) => {
  const out = {};
  for (const [id, room] of rooms.entries()) {
    out[id] = {
      players: playersListFromMap(room.players),
      clientsCount: room.clients.size,
      hostId: room.hostId,
      running: !!room.running,
      gemSeq: room.gemSeq,
      gemCount: room.gemCount,
      baseSpeed: room.baseSpeed,
      nextIncreaseThreshold: room.nextIncreaseThreshold,
      gemSinceLastIncrease: room.gemSinceLastIncrease,
      lastActivityMs: room.lastActivityMs || 0
    };
  }
  res.json(out);
});

app.post('/admin/terminate/:roomId', requireAdmin, (req, res) => {
  const roomId = req.params.roomId;
  const ok = terminateRoom(roomId, 'admin_terminate');
  if (ok) res.json({ ok: true, room: roomId });
  else res.status(404).json({ ok: false, error: 'room not found' });
});

app.post('/admin/terminate-all', requireAdmin, (req, res) => {
  const ids = Array.from(rooms.keys());
  ids.forEach(id => terminateRoom(id, 'admin_terminate_all'));
  res.json({ ok: true, terminated: ids.length });
});

// Create HTTP server + WS server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// upgrade
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Broadcast helper
function broadcastRoom(room, payload, exceptWs = null) {
  let s;
  if (typeof payload === 'string') s = payload;
  else {
    try { s = JSON.stringify(payload); } catch (e) { s = JSON.stringify({ type: 'error', message: 'payload_serialize_failed' }); }
  }
  for (const c of room.clients) {
    try {
      if (c && c.readyState === WebSocket.OPEN && c !== exceptWs) c.send(s);
    } catch (e) {
      // ignore
    }
  }
}

// Find room by WebSocket instance
function findRoomByWs(ws) {
  for (const [id, room] of rooms.entries()) {
    if (room.clients.has(ws)) return { id, room };
  }
  return null;
}

// Terminate a room gracefully
function terminateRoom(roomId, reason = 'admin') {
  const room = rooms.get(roomId);
  if (!room) return false;
  room.running = false;

  try { broadcastRoom(room, { type: 'room_terminated', room: roomId, reason }); } catch (e) { }

  try {
    for (const c of Array.from(room.clients)) {
      try {
        if (c && c.readyState === WebSocket.OPEN) c.close(4000, `room_terminated:${reason}`);
      } catch (e) { }
    }
  } catch (e) { }

  // optional leaderboard update
  try {
    if (room.hostId) {
      const score = Array.from(room.scores.values()).reduce((a, b) => a + b, 0) || room.gemCount || 0;
      leaderboard.push({ name: room.hostId, score });
      leaderboard.sort((a, b) => b.score - a.score);
    }
  } catch (e) { }

  rooms.delete(roomId);
  console.log(`Room ${roomId} terminated (${reason}).`);
  return true;
}

// Heartbeat and pruning
function heartbeat() { this.isAlive = true; }
setInterval(() => {
  const now = Date.now();
  // ping clients
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) { } continue; }
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

// Scores helper: return plain object mapping playerId->score
function scoresObjectFromRoom(room) {
  const obj = {};
  for (const pid of room.players.values()) {
    obj[pid] = room.scores.get(pid) || 0;
  }
  return obj;
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New WS connection from', (req && req.socket) ? (req.socket.remoteAddress || 'unknown') : 'unknown');
  ws.playerId = null;
  ws.roomId = null;
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (msg) => {
    let j;
    try { j = JSON.parse(msg.toString()); } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', message: 'invalid json' })); } catch (_) {}
      return;
    }

    const now = Date.now();
    const currentInfo = findRoomByWs(ws);
    if (currentInfo && currentInfo.room) currentInfo.room.lastActivityMs = now;

    // --- HELLO (standalone) ---
    if (j.type === 'hello') {
      // server returns authoritative assigned name
      const preferred = typeof j.name === 'string' && j.name.length > 0 ? j.name : null;
      const assigned = preferred || `Player-${randHex(2)}`;
      ws.playerId = assigned;
      try { ws.send(JSON.stringify({ type: 'hello_ack', ok: true, name: assigned })); } catch (e) {}
      console.log(`Hello from ${assigned}`);
      return;
    }

    // --- HOST REQUEST (create room) ---
    if (j.type === 'host_request') {
      const requestedId = (typeof j.playerId === 'string' && j.playerId.length > 0) ? j.playerId : null;
      // assign deterministic host id from request or generate
      const hostId = requestedId || `Host-${randHex(2)}`;
      let roomId;
      do { roomId = genRoomId(); } while (rooms.has(roomId));

      const room = {
        id: roomId,
        clients: new Set(),
        players: new Map(), // ws -> playerId
        hostWs: ws,
        hostId: hostId,
        gemSeq: 0,
        gemCount: 0,
        baseSpeed: INITIAL_GEM_SPEED, // start at 110 px/s (per your requirement)
        gemSinceLastIncrease: 0,
        nextIncreaseThreshold: randBetween(PROGRESSION_MIN, PROGRESSION_MAX),
        running: false,
        scores: new Map(), // playerId -> score
        lastActivityMs: now
      };

      rooms.set(roomId, room);
      room.clients.add(ws);
      room.players.set(ws, hostId);
      room.scores.set(hostId, 0);
      ws.playerId = hostId;
      ws.roomId = roomId;

      try {
        ws.send(JSON.stringify({ type: 'host_response', ok: true, room: roomId, players: playersListFromMap(room.players), baseSpeed: room.baseSpeed, nextIncreaseThreshold: room.nextIncreaseThreshold }));
      } catch (e) {}
      console.log(`Room ${roomId} created by ${hostId}`);
      return;
    }

    // --- JOIN ROOM ---
    if (j.type === 'join' && typeof j.room === 'string') {
      const room = rooms.get(j.room);
      if (!room) { try { ws.send(JSON.stringify({ type: 'join_response', ok: false, reason: 'room not found' })); } catch (e) {} return; }
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) { try { ws.send(JSON.stringify({ type: 'join_response', ok:false, reason:'room full' })); } catch (e) {} return; }

      // If client provided playerId use it, otherwise generate one consistently here
      const provided = (typeof j.playerId === 'string' && j.playerId.length > 0) ? j.playerId : null;
      // if provided equals an existing player's name, ensure uniqueness by appending suffix
      let playerId = provided || `Player-${randHex(2)}`;
      const existingNames = new Set(Array.from(room.players.values()));
      if (existingNames.has(playerId)) {
        playerId = `${playerId}-${randHex(1)}`; // add short suffix
      }

      room.clients.add(ws);
      room.players.set(ws, playerId);
      room.scores.set(playerId, 0);
      ws.playerId = playerId;
      ws.roomId = j.room;
      room.lastActivityMs = now;

      try {
        ws.send(JSON.stringify({ type: 'join_response', ok: true, room: j.room, players: playersListFromMap(room.players), baseSpeed: room.baseSpeed, nextIncreaseThreshold: room.nextIncreaseThreshold }));
        broadcastRoom(room, { type: 'player_joined', playerId, players: playersListFromMap(room.players) }, ws);
      } catch (e) {}
      console.log(`Player ${playerId} joined room ${j.room}`);
      return;
    }

    // --- START MATCH (host-only) ---
    if (j.type === 'start' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'error', message: 'room missing' })); } catch (e) {} return; }
      if (room.hostWs !== ws) { try { ws.send(JSON.stringify({ type: 'error', message: 'not host' })); } catch (e) {} return; }
      if (room.running) { try { ws.send(JSON.stringify({ type: 'error', message: 'already running' })); } catch (e) {} return; }

      // prepare room for match
      room.running = true;
      room.gemSeq = 0;
      room.gemCount = 0;
      room.gemSinceLastIncrease = 0;
      room.baseSpeed = INITIAL_GEM_SPEED;
      room.nextIncreaseThreshold = randBetween(PROGRESSION_MIN, PROGRESSION_MAX);
      // reset scores for existing players (keeps host/player IDs!)
      for (const pid of room.players.values()) room.scores.set(pid, 0);

      room.lastActivityMs = now;

      broadcastRoom(room, { type: 'start', room: ws.roomId, seed: Date.now(), players: playersListFromMap(room.players), baseSpeed: room.baseSpeed, nextIncreaseThreshold: room.nextIncreaseThreshold });
      console.log(`Match started in room ${ws.roomId} (host ${room.hostId})`);

      // spawn loop (asynchronous)
      spawnLoop(room, ws.roomId).catch(err => console.error('spawnLoop error', err));
      return;
    }

    // --- END GAME (host-only) ---
    if (j.type === 'end_game' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) { try { ws.send(JSON.stringify({ type: 'end_ack', ok: false, reason: 'room_missing' })); } catch (e) {} return; }
      if (room.hostWs !== ws) { try { ws.send(JSON.stringify({ type: 'end_ack', ok: false, reason: 'not_host' })); } catch (e) {} return; }

      try { ws.send(JSON.stringify({ type: 'end_ack', ok: true, room: ws.roomId })); } catch (e) {}

      // push host score into leaderboard as convenience
      try {
        const hostScore = Array.from(room.scores.entries()).reduce((acc, [k, v]) => Math.max(acc, v), 0) || room.gemCount || 0;
        leaderboard.push({ name: room.hostId || 'host', score: hostScore });
        leaderboard.sort((a, b) => b.score - a.score);
      } catch (e) {}

      terminateRoom(ws.roomId, 'host_requested_end');
      return;
    }

    // --- CAUGHT / MISSED handling (gameplay events) ---
    // caught: { type: 'caught', gemId: 'g1', points: 1? }
    // missed: { type: 'missed', gemId: 'g2' }
    if ((j.type === 'caught' || j.type === 'missed') && ws.roomId) {
      const info = findRoomByWs(ws);
      if (!info) return;
      const room = info.room;
      const pid = ws.playerId;

      if (j.type === 'caught') {
        const points = (typeof j.points === 'number') ? j.points : 1;
        const prev = room.scores.get(pid) || 0;
        room.scores.set(pid, prev + points);
        // Broadcast score update and caught event
        broadcastRoom(room, { type: 'player_caught', playerId: pid, gemId: j.gemId, points, scores: scoresObjectFromRoom(room) });
        return;
      }

      if (j.type === 'missed') {
        // eliminate the player from the room
        room.players.delete(ws);
        room.clients.delete(ws);
        const playerScore = room.scores.get(pid) || 0;
        room.scores.delete(pid);
        broadcastRoom(room, { type: 'player_eliminated', playerId: pid, score: playerScore });

        console.log(`Player ${pid} eliminated in room ${info.id}`);

        // if only one remains, declare winner + scores and terminate the room
        if (room.players.size === 1) {
          const winnerId = Array.from(room.players.values())[0];
          const scoresObj = scoresObjectFromRoom(room);
          broadcastRoom(room, { type: 'match_over', winner: winnerId, scores: scoresObj });

          // update leaderboard
          try {
            const finalScore = Object.values(scoresObj).reduce((a, b) => Math.max(a, b), 0) || room.gemCount || 0;
            leaderboard.push({ name: winnerId, score: finalScore });
            leaderboard.sort((a, b) => b.score - a.score);
          } catch (e) {}

          room.running = false;
          console.log(`Match over in ${info.id}, winner ${winnerId}`);

          // optionally terminate room now
          terminateRoom(info.id, 'match_over');
          return;
        }

        // remove empty room if no players left
        if (room.clients.size === 0) {
          rooms.delete(info.id);
          console.log(`Deleted empty room ${info.id}`);
        }
        return;
      }
    }

    // --- GENERIC RELAY for clients already in a room (useful for custom messages) ---
    if (ws.roomId) {
      const info = findRoomByWs(ws);
      if (!info) { try { ws.send(JSON.stringify({ type: 'error', message: 'not joined' })); } catch (e) {} return; }
      // broadcast to others
      broadcastRoom(info.room, j, ws);
      return;
    }

    // --- fallback: unsupported message from not-in-room client ---
    try { ws.send(JSON.stringify({ type: 'error', message: 'not joined or unsupported message type' })); } catch (e) {}
  }); // end message

  ws.on('close', () => {
    const info = findRoomByWs(ws);
    if (info) {
      const { id, room } = info;
      const pid = room.players.get(ws);
      room.players.delete(ws);
      room.clients.delete(ws);
      // keep scores entry for reporting if desired OR remove it - here we keep for match summary
      broadcastRoom(room, { type: 'player_left', playerId: pid, scores: scoresObjectFromRoom(room) });
      console.log(`WS closed: ${pid} left room ${id}`);

      if (room.clients.size === 0) {
        rooms.delete(id);
        console.log(`Deleted empty room ${id}`);
      } else if (room.hostWs === ws) {
        // choose new host deterministically (first client in Set)
        const iter = room.clients.values();
        const newHostWs = iter.next().value;
        room.hostWs = newHostWs;
        room.hostId = room.players.get(newHostWs);
        broadcastRoom(room, { type: 'host_changed', newHost: room.hostId, players: playersListFromMap(room.players) });
        console.log(`Host for room ${id} changed to ${room.hostId}`);
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('WS error', err && err.message ? err.message : err);
  });
}); // end connection

// --- Spawn loop (authoritative) ---
// Behavior per your request:
//  - Each room has baseSpeed (starting 110) used by clients as the gem fall speed in px/s.
//  - Each room has nextIncreaseThreshold randomly chosen in [20,35].
//  - When gemSinceLastIncrease >= nextIncreaseThreshold => baseSpeed += 1, gemSinceLastIncrease = 0, new threshold random in [20,35].
//  - Spawn payload includes gemId, x, and baseSpeed (server's authoritative speed).
async function spawnLoop(room, roomId) {
  try {
    if (!room || !room.running) return;

    // the server chooses an interval; clients adapt coordinates/time to their viewport
    const baseIntervalMs = 1000; // base interval
    // we map baseSpeed influence to spawn frequency lightly: higher baseSpeed => slightly faster spawns
    // but the main mechanic is that server sends the baseSpeed for clients to use for velocity
    const intervalMs = Math.max(150, Math.floor(baseIntervalMs / (1 + (room.baseSpeed - INITIAL_GEM_SPEED) / 200))); // tuned formula

    await new Promise(resolve => setTimeout(resolve, intervalMs));

    // make sure room still exists & running
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
    const worldWidth = 800; // suggestion; clients should map to their viewport width
    const x = Math.floor(Math.random() * worldWidth);
    const speed = Math.min(MAX_SPAWN_SPEED, currentRoom.baseSpeed); // baseSpeed is px/s

    // broadcast spawn
    broadcastRoom(currentRoom, { type: 'gem_spawn', room: roomId, gemId, x, speed, seq: currentRoom.gemSeq, time: Date.now() });

    // progression: randomized threshold per room -> when reached, increment baseSpeed by 1
    if (currentRoom.gemSinceLastIncrease >= currentRoom.nextIncreaseThreshold) {
      currentRoom.baseSpeed = Math.min(MAX_SPAWN_SPEED, currentRoom.baseSpeed + 1);
      currentRoom.gemSinceLastIncrease = 0;
      currentRoom.nextIncreaseThreshold = randBetween(PROGRESSION_MIN, PROGRESSION_MAX);
      broadcastRoom(currentRoom, { type: 'speed_update', baseSpeed: currentRoom.baseSpeed, nextIncreaseThreshold: currentRoom.nextIncreaseThreshold });
      console.log(`Room ${roomId} baseSpeed increased -> ${currentRoom.baseSpeed} next threshold ${currentRoom.nextIncreaseThreshold}`);
      if (currentRoom.baseSpeed >= MAX_SPAWN_SPEED) {
        console.warn(`Room ${roomId} reached MAX_SPAWN_SPEED (${MAX_SPAWN_SPEED}) -> terminating.`);
        terminateRoom(roomId, 'max_spawn_speed');
        return;
      }
    }

    // continue loop
    return spawnLoop(currentRoom, roomId);
  } catch (err) {
    console.error('spawnLoop error', err && err.stack ? err.stack : err);
  }
}

// Graceful shutdown
function gracefulShutdown() {
  console.log('Graceful shutdown initiated...');
  for (const id of Array.from(rooms.keys())) terminateRoom(id, 'server_shutdown');
  try {
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('Forcing exit.');
      process.exit(0);
    }, 5000);
  } catch (e) {
    console.error('Shutdown error', e);
    process.exit(1);
  }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start server
server.listen(PORT, () => console.log(`HTTP + WS server listening on ${PORT}`));

/**
 * Client message reference recap (server expects these):
 *
 * - hello:
 *    { type: "hello", name: "<desired>" }
 *    -> server replies: { type: "hello_ack", ok: true, name: "<assigned>" }
 *
 * - host_request:
 *    { type: "host_request", playerId: "<optional>" }
 *    -> server replies: { type: "host_response", ok: true, room: "<roomId>", players: [...], baseSpeed: 110, nextIncreaseThreshold: 23 }
 *
 * - join:
 *    { type: "join", room: "1234", playerId: "<optional>" }
 *    -> server replies: { type: "join_response", ok:true, room:"1234", players:[...], baseSpeed:110, nextIncreaseThreshold:22 }
 *
 * - start (host only):
 *    { type: "start" }
 *    -> server broadcasts: { type: "start", room:"1234", players:[...], baseSpeed:110, nextIncreaseThreshold:25 }
 *
 * - gem_spawn (server -> clients):
 *    { type: "gem_spawn", room:"1234", gemId:"g1", x:123, speed:110, seq:1, time:... }
 *    -> clients should map server speed directly to their Gem speed property (for single/multiplayer parity).
 *
 * - caught (client -> server):
 *    { type: "caught", gemId: "g1", points: 1 }  // points optional (default 1)
 *    -> server updates the player's score and broadcasts player_caught + scores
 *
 * - missed (client -> server):
 *    { type: "missed", gemId: "g2" }
 *    -> server eliminates the player, broadcasts player_eliminated, and if 1 remains broadcasts match_over with scores
 *
 * - match_over (server -> clients):
 *    { type: "match_over", winner: "<id>", scores: { "<player>": <score>, ... } }
 *
 * Implementation notes for your Godot client (quick checklist):
 *  - When you create/host a room, use the server-supplied name in host_response / hello_ack instead of keeping a locally-generated name.
 *  - When players join, update the players UI with the authoritative players array the server sends.
 *  - Use the server-supplied `speed` in gem_spawn or `baseSpeed` from speed_update to set Gem drop velocity (so multiplayer matches match single-player speeds).
 *  - When sending caught, include points for special gems: { type:'caught', gemId:'g1', points:5 }.
 *  - On match_over, show the WinnerDialog and the per-player scores returned in the `scores` object.
 *
 * If you want I can:
 *  - Provide a minimal Godot C# snippet showing how to map server baseSpeed -> Gem.SetSpeed(...) and how to parse match_over and show AcceptDialog with per-player scores.
 *  - Provide a small Node.js test client that simulates host + two clients for local testing.
 */
