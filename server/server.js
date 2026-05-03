import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3001;
const TICK_MS = 50;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const MAX_HP = 100;
const BASIC_DAMAGE = 34;
const SPECIAL_DAMAGE = 34;
const SHOT_COOLDOWN_MS = 180;
const SHOT_RANGE = 60;
const HIT_RADIUS = 0.75;
const RESPAWN_DELAY_MS = 1500;
const FREEZE_DURATION_MS = 1000;
const MARK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

const ALLOWED_ORIGINS = CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const playerCount = Array.from(rooms.values()).reduce((sum, r) => sum + r.size, 0);
    res.end(JSON.stringify({ ok: true, players: playerCount, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Socket server is running.');
});

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : true },
});

const rooms = new Map();        // roomCode → Map<socketId, player>
const socketMeta = new Map();   // socketId → { roomCode }
// markedTargets: shooterId → Map<targetId, expiresAt>
const markedTargets = new Map();

io.on('connection', (socket) => {
  socketMeta.set(socket.id, { roomCode: null });

  socket.on('joinRoom', (payload) => {
    const nickname = sanitizeNickname(payload?.nickname);
    const roomCode = normalizeRoomCode(payload?.roomCode);
    if (!roomCode) { socket.emit('joinError', 'Invalid room code'); return; }

    const targetRoom = rooms.get(roomCode);
    if (targetRoom) {
      const dup = Array.from(targetRoom.values()).some(
        (p) => p.id !== socket.id && p.nickname.toLowerCase() === nickname.toLowerCase()
      );
      if (dup) { socket.emit('joinError', 'Nickname already used in this room'); return; }
    }

    leaveCurrentRoom(socket);
    socket.join(roomCode);
    socketMeta.set(socket.id, { roomCode });

    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    const roomPlayers = rooms.get(roomCode);
    const spawn = randomSpawn();
    const player = {
      id: socket.id, nickname, roomCode,
      position: { x: spawn.x, y: 1.7, z: spawn.z },
      yaw: Math.PI, hp: MAX_HP, kills: 0, deaths: 0,
      isAlive: true, lastShotAt: 0, frozenUntil: 0,
    };
    roomPlayers.set(socket.id, player);

    socket.emit('bootstrap', { id: socket.id, roomCode, players: Array.from(roomPlayers.values()) });
    socket.to(roomCode).emit('playerJoined', player);
    emitRoomInfo(roomCode);
  });

  socket.on('playerUpdate', (payload) => {
    const { roomCode } = socketMeta.get(socket.id) ?? {};
    if (!roomCode) return;
    const player = rooms.get(roomCode)?.get(socket.id);
    if (!player || !player.isAlive) return;

    if (payload?.position) {
      player.position.x = Number(payload.position.x) || 0;
      player.position.y = Number(payload.position.y) || 1.7;
      player.position.z = Number(payload.position.z) || 0;
    }
    if (typeof payload?.yaw === 'number') player.yaw = payload.yaw;
  });

  socket.on('shoot', (payload) => {
    const { roomCode } = socketMeta.get(socket.id) ?? {};
    if (!roomCode) return;
    const roomPlayers = rooms.get(roomCode);
    if (!roomPlayers) return;
    const shooter = roomPlayers.get(socket.id);
    if (!shooter || !shooter.isAlive) return;

    const now = Date.now();
    if (shooter.frozenUntil > now) return;
    if (now - shooter.lastShotAt < SHOT_COOLDOWN_MS) return;
    shooter.lastShotAt = now;

    const attackType = payload?.attackType ?? 'basic'; // 'basic' | 'special' | 'nonlethal'
    const origin = sanitizeVector(payload?.origin, shooter.position);
    const direction = sanitizeDirection(payload?.direction);
    if (!direction) return;

    // Find closest target in ray
    let closestTarget = null;
    let closestT = SHOT_RANGE + 1;

    for (const target of roomPlayers.values()) {
      if (target.id === shooter.id || !target.isAlive) continue;
      const center = { x: target.position.x, y: target.position.y - 0.2, z: target.position.z };
      const toTarget = { x: center.x - origin.x, y: center.y - origin.y, z: center.z - origin.z };
      const t = toTarget.x * direction.x + toTarget.y * direction.y + toTarget.z * direction.z;
      if (t < 0 || t > SHOT_RANGE || t >= closestT) continue;
      const cx = origin.x + direction.x * t, cy = origin.y + direction.y * t, cz = origin.z + direction.z * t;
      const dx = center.x - cx, dy = center.y - cy, dz = center.z - cz;
      if (dx * dx + dy * dy + dz * dz <= HIT_RADIUS * HIT_RADIUS) {
        closestTarget = target;
        closestT = t;
      }
    }

    if (!closestTarget) {
      // Missed — award nonlethal bullet to shooter for basic miss
      if (attackType === 'basic') {
        socket.emit('shotMissed');
      }
      return;
    }

    // Non-lethal: freeze, no HP damage
    if (attackType === 'nonlethal') {
      closestTarget.frozenUntil = now + FREEZE_DURATION_MS;
      io.to(closestTarget.id).emit('playerFrozen');
      setTimeout(() => {
        const p = rooms.get(roomCode)?.get(closestTarget.id);
        if (p) p.frozenUntil = 0;
      }, FREEZE_DURATION_MS);
      return;
    }

    // Check mark restriction: if target is marked by this shooter, only special can damage
    if (attackType === 'basic') {
      const myMarks = markedTargets.get(socket.id);
      if (myMarks) {
        const expiresAt = myMarks.get(closestTarget.id);
        if (expiresAt && expiresAt > now) {
          // Target is marked — basic attack can't hurt them
          return;
        }
      }
    }

    // Apply damage
    const damage = attackType === 'special' ? SPECIAL_DAMAGE : BASIC_DAMAGE;
    closestTarget.hp = Math.max(0, closestTarget.hp - damage);
    io.to(closestTarget.id).emit('damageTaken', { by: shooter.nickname, hp: closestTarget.hp });

    if (closestTarget.hp > 0) return;

    // Kill
    closestTarget.isAlive = false;
    closestTarget.deaths += 1;
    shooter.kills += 1;

    // Determine kill effect type
    let killEffect = 'circle';
    if (attackType === 'special') {
      const myMarks = markedTargets.get(socket.id);
      if (myMarks && myMarks.has(closestTarget.id)) {
        killEffect = 'triangle';
        myMarks.delete(closestTarget.id);
      }
    }

    io.to(roomCode).emit('playerDied', {
      killerId: shooter.id,
      killerName: shooter.nickname,
      victimId: closestTarget.id,
      victimName: closestTarget.nickname,
      killEffect,
    });

    setTimeout(() => {
      const playersInRoom = rooms.get(roomCode);
      if (!playersInRoom) return;
      const p = playersInRoom.get(closestTarget.id);
      if (!p) return;
      const spawn = randomSpawn();
      p.position = { x: spawn.x, y: 1.7, z: spawn.z };
      p.hp = MAX_HP;
      p.isAlive = true;
      p.frozenUntil = 0;
      io.to(p.id).emit('playerRespawn', { position: p.position });
    }, RESPAWN_DELAY_MS);
  });

  socket.on('wrongAnswer', (payload) => {
    const { roomCode } = socketMeta.get(socket.id) ?? {};
    if (!roomCode) return;
    const roomPlayers = rooms.get(roomCode);
    if (!roomPlayers) return;
    const shooter = roomPlayers.get(socket.id);
    if (!shooter) return;

    const requestedId = payload?.nearestEnemyId;
    const english = String(payload?.english ?? '').slice(0, 64);
    const korean = String(payload?.korean ?? '').slice(0, 128);

    // Validate that requestedId is actually a player in the room
    const target = requestedId ? roomPlayers.get(requestedId) : null;
    if (!target || !target.isAlive || target.id === socket.id) return;

    const expiresAt = Date.now() + MARK_DURATION_MS;

    if (!markedTargets.has(socket.id)) markedTargets.set(socket.id, new Map());
    markedTargets.get(socket.id).set(target.id, expiresAt);

    socket.emit('enemyMarked', {
      targetId: target.id,
      english,
      korean,
      expiresAt,
    });
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    socketMeta.delete(socket.id);
    markedTargets.delete(socket.id);
    // Remove this player from other shooters' marks
    for (const marks of markedTargets.values()) marks.delete(socket.id);
  });
});

setInterval(() => {
  for (const [roomCode, roomPlayers] of rooms.entries()) {
    io.to(roomCode).emit('worldState', Array.from(roomPlayers.values()));
  }

  // Clean expired marks
  const now = Date.now();
  for (const marks of markedTargets.values()) {
    for (const [targetId, expiresAt] of marks.entries()) {
      if (expiresAt <= now) marks.delete(targetId);
    }
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Multiplayer server running on port ${PORT} (origins: ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(', ') : 'any'})`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function randomSpawn() {
  const spread = 10;
  return { x: (Math.random() - 0.5) * spread, z: (Math.random() - 0.5) * spread };
}

function sanitizeNickname(raw) {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return `Player-${Math.floor(Math.random() * 900 + 100)}`;
  return text.slice(0, 16);
}

function normalizeRoomCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return code || null;
}

function leaveCurrentRoom(socket) {
  const { roomCode } = socketMeta.get(socket.id) ?? {};
  if (!roomCode) return;
  const roomPlayers = rooms.get(roomCode);
  if (!roomPlayers) return;
  roomPlayers.delete(socket.id);
  socket.leave(roomCode);
  socket.to(roomCode).emit('playerLeft', socket.id);
  if (roomPlayers.size === 0) { rooms.delete(roomCode); return; }
  emitRoomInfo(roomCode);
}

function emitRoomInfo(roomCode) {
  const count = rooms.get(roomCode)?.size ?? 0;
  io.to(roomCode).emit('roomInfo', { roomCode, count });
}

function sanitizeVector(raw, fallback) {
  const x = Number(raw?.x), y = Number(raw?.y), z = Number(raw?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback;
  return { x, y, z };
}

function sanitizeDirection(raw) {
  const x = Number(raw?.x), y = Number(raw?.y), z = Number(raw?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const len = Math.hypot(x, y, z);
  if (len < 1e-5) return null;
  return { x: x / len, y: y / len, z: z / len };
}
