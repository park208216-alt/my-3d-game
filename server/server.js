import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3001;
const TICK_MS = 50;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const MAX_HP = 100;
const SHOT_DAMAGE = 34;
const SHOT_COOLDOWN_MS = 180;
const SHOT_RANGE = 60;
const HIT_RADIUS = 0.75;
const RESPAWN_DELAY_MS = 1500;
const ALLOWED_ORIGINS = CLIENT_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    const playerCount = Array.from(rooms.values()).reduce((sum, room) => sum + room.size, 0);
    res.end(JSON.stringify({ ok: true, players: playerCount, rooms: rooms.size }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Socket server is running.');
});
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : true,
  },
});

const rooms = new Map();
const socketMeta = new Map();

io.on('connection', (socket) => {
  socketMeta.set(socket.id, { roomCode: null });

  socket.on('joinRoom', (payload) => {
    const nickname = sanitizeNickname(payload?.nickname);
    const roomCode = normalizeRoomCode(payload?.roomCode);
    if (!roomCode) {
      socket.emit('joinError', 'Invalid room code');
      return;
    }

    const targetRoomPlayers = rooms.get(roomCode);
    if (targetRoomPlayers) {
      const duplicate = Array.from(targetRoomPlayers.values()).some(
        (existing) =>
          existing.id !== socket.id &&
          existing.nickname.toLowerCase() === nickname.toLowerCase()
      );
      if (duplicate) {
        socket.emit('joinError', 'Nickname already used in this room');
        return;
      }
    }

    leaveCurrentRoom(socket);
    socket.join(roomCode);
    socketMeta.set(socket.id, { roomCode });

    if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
    const roomPlayers = rooms.get(roomCode);

    const spawn = randomSpawn();
    const player = {
      id: socket.id,
      nickname,
      roomCode,
      position: { x: spawn.x, y: 1.7, z: spawn.z },
      yaw: Math.PI,
      hp: MAX_HP,
      kills: 0,
      deaths: 0,
      isAlive: true,
      lastShotAt: 0,
    };
    roomPlayers.set(socket.id, player);

    socket.emit('bootstrap', {
      id: socket.id,
      roomCode,
      players: Array.from(roomPlayers.values()),
    });
    socket.to(roomCode).emit('playerJoined', player);
    emitRoomInfo(roomCode);
  });

  socket.on('playerUpdate', (payload) => {
    const roomCode = socketMeta.get(socket.id)?.roomCode;
    if (!roomCode) return;
    const roomPlayers = rooms.get(roomCode);
    if (!roomPlayers) return;
    const player = roomPlayers.get(socket.id);
    if (!player) return;
    if (!player.isAlive) return;

    if (payload?.position) {
      player.position.x = Number(payload.position.x) || 0;
      player.position.y = Number(payload.position.y) || 1.7;
      player.position.z = Number(payload.position.z) || 0;
    }

    if (typeof payload?.yaw === 'number') {
      player.yaw = payload.yaw;
    }
  });

  socket.on('shoot', (payload) => {
    const roomCode = socketMeta.get(socket.id)?.roomCode;
    if (!roomCode) return;
    const roomPlayers = rooms.get(roomCode);
    if (!roomPlayers) return;
    const shooter = roomPlayers.get(socket.id);
    if (!shooter || !shooter.isAlive) return;

    const now = Date.now();
    if (now - shooter.lastShotAt < SHOT_COOLDOWN_MS) return;
    shooter.lastShotAt = now;

    const origin = sanitizeVector(payload?.origin, shooter.position);
    const direction = sanitizeDirection(payload?.direction);
    if (!direction) return;

    let closestTarget = null;
    let closestT = SHOT_RANGE + 1;

    for (const target of roomPlayers.values()) {
      if (target.id === shooter.id || !target.isAlive) continue;
      const center = { x: target.position.x, y: target.position.y - 0.2, z: target.position.z };
      const toTarget = {
        x: center.x - origin.x,
        y: center.y - origin.y,
        z: center.z - origin.z,
      };

      const t = toTarget.x * direction.x + toTarget.y * direction.y + toTarget.z * direction.z;
      if (t < 0 || t > SHOT_RANGE || t >= closestT) continue;

      const closest = {
        x: origin.x + direction.x * t,
        y: origin.y + direction.y * t,
        z: origin.z + direction.z * t,
      };
      const dx = center.x - closest.x;
      const dy = center.y - closest.y;
      const dz = center.z - closest.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq <= HIT_RADIUS * HIT_RADIUS) {
        closestTarget = target;
        closestT = t;
      }
    }

    if (!closestTarget) return;

    closestTarget.hp = Math.max(0, closestTarget.hp - SHOT_DAMAGE);
    io.to(closestTarget.id).emit('damageTaken', {
      by: shooter.nickname,
      hp: closestTarget.hp,
    });

    if (closestTarget.hp > 0) return;

    closestTarget.isAlive = false;
    closestTarget.deaths += 1;
    shooter.kills += 1;
    io.to(roomCode).emit('playerDied', {
      killerId: shooter.id,
      killerName: shooter.nickname,
      victimId: closestTarget.id,
      victimName: closestTarget.nickname,
    });

    setTimeout(() => {
      const playersInRoom = rooms.get(roomCode);
      if (!playersInRoom) return;
      const playerToRespawn = playersInRoom.get(closestTarget.id);
      if (!playerToRespawn) return;
      const spawn = randomSpawn();
      playerToRespawn.position = { x: spawn.x, y: 1.7, z: spawn.z };
      playerToRespawn.hp = MAX_HP;
      playerToRespawn.isAlive = true;
      io.to(playerToRespawn.id).emit('playerRespawn', { position: playerToRespawn.position });
    }, RESPAWN_DELAY_MS);
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
    socketMeta.delete(socket.id);
  });
});

setInterval(() => {
  for (const [roomCode, roomPlayers] of rooms.entries()) {
    io.to(roomCode).emit('worldState', Array.from(roomPlayers.values()));
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(
    `Multiplayer server running on port ${PORT} (origins: ${
      ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(', ') : 'any'
    })`
  );
});

function randomSpawn() {
  const spread = 10;
  return {
    x: (Math.random() - 0.5) * spread,
    z: (Math.random() - 0.5) * spread,
  };
}

function sanitizeNickname(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return `Player-${Math.floor(Math.random() * 900 + 100)}`;
  return text.slice(0, 16);
}

function normalizeRoomCode(raw) {
  const code = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return code || null;
}

function leaveCurrentRoom(socket) {
  const roomCode = socketMeta.get(socket.id)?.roomCode;
  if (!roomCode) return;

  const roomPlayers = rooms.get(roomCode);
  if (!roomPlayers) return;

  roomPlayers.delete(socket.id);
  socket.leave(roomCode);
  socket.to(roomCode).emit('playerLeft', socket.id);

  if (roomPlayers.size === 0) {
    rooms.delete(roomCode);
    return;
  }
  emitRoomInfo(roomCode);
}

function emitRoomInfo(roomCode) {
  const roomPlayers = rooms.get(roomCode);
  const count = roomPlayers?.size ?? 0;
  io.to(roomCode).emit('roomInfo', { roomCode, count });
}

function sanitizeVector(raw, fallback) {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return fallback;
  return { x, y, z };
}

function sanitizeDirection(raw) {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const len = Math.hypot(x, y, z);
  if (len < 1e-5) return null;
  return { x: x / len, y: y / len, z: z / len };
}
