// server.js (enhanced with admin controls, safety caps, and host-triggered end_game)
//
// Usage:
//  - Start normally:   node server.js
//  - Set admin token:  ADMIN_TOKEN=yourtoken node server.js
//
// Admin endpoints (protected by ADMIN_TOKEN header x-admin-token if configured,
// otherwise only accessible from localhost):
//  GET  /admin/rooms                -> list rooms status
//  POST /admin/terminate/:roomId    -> terminate single room
//  POST /admin/terminate-all        -> terminate all rooms
//
// Supports hello, host_request, join, start, gem_spawn, caught/missed,
// and new host end_game request handling.

const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

// safety caps
const MAX_SPAWN_SPEED = parseFloat(process.env.MAX_SPAWN_SPEED || "10000"); // absolute cap
const SPEED_INCREASE_FACTOR = 1.1; // same as original 10% increase
const MAX_GEM_COUNT = parseInt(process.env.MAX_GEM_COUNT || "200000"); // guard against runaway

const wss = new WebSocket.Server({ noServer: true });

// Rooms: Map<roomId, roomObj>
const rooms = new Map();
// Leaderboard: array of { name, score } sorted desc
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

// --- admin middleware ---
function requireAdmin(req, res, next) {
  if (ADMIN_TOKEN) {
    const token = req.get('x-admin-token') || req.query.admin_token;
    if (!token || token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  } else {
    // restrict to localhost when no admin token present
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    return res.status(403).json({ error: 'admin access restricted (set ADMIN_TOKEN to enable remote admin)' });
  }
}

// admin list rooms
app.get('/admin/rooms', requireAdmin, (req, res) => {
  const out = {};
  for (const [id, room] of rooms.entries()) {
    out[id] = {
      players: Array.from(room.players ? room.players.values() : []),
      clientsCount: room.clients ? room.clients.size : 0,
      hostId: room.hostId,
      running: !!room.running,
      gemSeq: room.gemSeq || 0,
      gemCount: room.gemCount || 0,
      spawnSpeed: room.spawnSpeed || 0
    };
  }
  res.json(out);
});

// admin terminate a specific room
app.post('/admin/terminate/:roomId', requireAdmin, (req, res) => {
  const roomId = req.params.roomId;
  const ok = terminateRoom(roomId, 'admin_terminate');
  if (ok) res.json({ ok: true, room: roomId });
  else res.status(404).json({ ok: false, error: 'room not found' });
});

// admin terminate all rooms
app.post('/admin/terminate-all', requireAdmin, (req, res) => {
  const ids = Array.from(rooms.keys());
  ids.forEach(id => terminateRoom(id, 'admin_terminate_all'));
  res.json({ ok: true, terminated: ids.length });
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
  // payload may be an object or a pre-stringified JSON
  let s;
  if (typeof payload === 'string') s = payload;
  else {
    try { s = JSON.stringify(payload); }
    catch (e) { s = JSON.stringify({ type: 'error', message: 'payload_serialize_failed' }); }
  }
  if (!room || !room.clients) return;
  for (const c of room.clients) {
    try {
      if (c.readyState === WebSocket.OPEN && c !== exceptWs) c.send(s);
    } catch (e) {
      // ignore per-connection send errors
    }
  }
}

function findRoomByWs(ws) {
  for (const [id, room] of rooms.entries()) {
    if (room.clients && room.clients.has(ws)) return { id, room };
  }
  return null;
}

// terminate a room and clean up sockets and memory
function terminateRoom(roomId, reason = 'admin') {
  const room = rooms.get(roomId);
  if (!room) return false;

  // mark not running so spawnLoop will not continue
  room.running = false;

  // notify clients and close connections
  try {
    broadcastRoom(room, { type: 'room_terminated', room: roomId, reason });
  } catch (e) { /* ignore */ }

  // close client sockets and remove references
  try {
    for (const c of Array.from(room.clients)) {
      try {
        if (c.readyState === WebSocket.OPEN) {
          // send a close code and reason; clients should handle this cleanly
          c.close(4000, `room_terminated:${reason}`);
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // optionally update leaderboard with host info when admin terminates
  try {
    if (room.hostId) {
      // simple heuristic: give host a score equal to gemCount (or 0)
      const score = room.gemCount || 0;
      leaderboard.push({ name: room.hostId, score });
      leaderboard.sort((a, b) => b.score - a.score);
    }
  } catch (e) { /* ignore leaderboard failures */ }

  // remove room
  rooms.delete(roomId);
  console.log(`Room ${roomId} terminated (${reason}).`);
  return true;
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('New WS connection from', req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown');
  ws.playerId = null;
  ws.roomId = null;

  ws.on('message', (msg) => {
    let j;
    try { j = JSON.parse(msg.toString()); } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }

    // ---------- Hello ----------
    if (j.type === 'hello') {
      const clientName = (typeof j.name === 'string' && j.name.length > 0) ? j.name : ('Player-' + crypto.randomBytes(2).toString('hex'));
      ws.playerId = clientName;
      ws.send(JSON.stringify({ type: 'hello_ack', ok: true, name: clientName }));
      console.log(`Hello from ${clientName} (no room)`);
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
      // optional: limit players per room (4 for example)
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
      console.log(`Match started in ${ws.roomId}`);
      spawnLoop(room, ws.roomId);
      return;
    }

    // ---------- End game request (host can request to terminate the room) ----------
    if (j.type === 'end_game' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type:'end_ack', ok:false, reason:'room_missing' }));
        return;
      }
      if (room.hostWs !== ws) {
        ws.send(JSON.stringify({ type:'end_ack', ok:false, reason:'not_host' }));
        return;
      }

      // Respond to host immediately
      ws.send(JSON.stringify({ type: 'end_ack', ok: true, room: ws.roomId }));

      // Optionally add host to leaderboard with room's gemCount (simple score)
      try {
        const score = room.gemCount || 0;
        leaderboard.push({ name: room.hostId || 'host', score });
        leaderboard.sort((a, b) => b.score - a.score);
      } catch (e) { /* ignore leaderboard update errors */ }

      // Terminate the room gracefully (broadcast and close sockets)
      const terminated = terminateRoom(ws.roomId, 'host_requested_end');
      if (!terminated) {
        console.warn(`end_game requested but terminateRoom failed for ${ws.roomId}`);
      }
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

        // If only one player left, declare winner and cleanup
        if (room.players.size === 1) {
          const winner = Array.from(room.players.values())[0];

          // Update leaderboard with winner
          try {
            const score = room.gemCount || 0;
            leaderboard.push({ name: winner, score });
            leaderboard.sort((a, b) => b.score - a.score);
          } catch (e) { /* ignore */ }

          broadcastRoom(room, { type:'match_over', winner });
          room.running = false;
          console.log(`Match over in ${info.id}, winner ${winner}`);

          // optionally terminate room immediately
          terminateRoom(info.id, 'match_over');
        }

        if (room.clients.size === 0) {
          rooms.delete(info.id);
          console.log(`Deleted empty room ${info.id}`);
        }
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
      // relay other messages to the room (payload is already object; broadcastRoom will stringify)
      broadcastRoom(info.room, j, ws);
    } else {
      // unknown message from client not in room -> error
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

// server-side spawn loop (recursive setTimeout)
function spawnLoop(room, roomId) {
  if (!room || !room.running) return;
  const baseIntervalMs = 1000;
  const intervalMs = Math.max(200, Math.floor(baseIntervalMs / room.spawnSpeed));
  setTimeout(() => {
    // check room still exists and running
    const currentRoom = rooms.get(roomId);
    if (!currentRoom || !currentRoom.running) return;

    // safety guard: if gemCount is crazy high, auto-terminate
    currentRoom.gemSeq = (currentRoom.gemSeq || 0) + 1;
    currentRoom.gemCount = (currentRoom.gemCount || 0) + 1;

    if (currentRoom.gemCount > MAX_GEM_COUNT) {
      console.warn(`Room ${roomId} exceeded MAX_GEM_COUNT (${currentRoom.gemCount}) -> terminating.`);
      terminateRoom(roomId, 'max_gem_count');
      return;
    }

    const gemId = 'g' + currentRoom.gemSeq;
    const x = Math.floor(Math.random() * 800); // clients should adapt world width
    const speed = currentRoom.spawnSpeed;

    broadcastRoom(currentRoom, { type:'gem_spawn', room: roomId, gemId, x, speed, seq: currentRoom.gemSeq, time: Date.now() });

    // speed increase every 25 gems
    if (currentRoom.gemCount % 25 === 0) {
      currentRoom.spawnSpeed = Math.min(MAX_SPAWN_SPEED, currentRoom.spawnSpeed * SPEED_INCREASE_FACTOR);
      broadcastRoom(currentRoom, { type:'speed_update', spawnSpeed: currentRoom.spawnSpeed });
      console.log(`Room ${roomId} speed up -> ${currentRoom.spawnSpeed}`);

      // If spawnSpeed reached cap, optionally terminate (you can also choose to just cap)
      if (currentRoom.spawnSpeed >= MAX_SPAWN_SPEED) {
        console.warn(`Room ${roomId} reached MAX_SPAWN_SPEED (${MAX_SPAWN_SPEED}) -> terminating.`);
        terminateRoom(roomId, 'max_spawn_speed');
        return;
      }
    }

    // continue loop
    spawnLoop(currentRoom, roomId);
  }, intervalMs);
}
