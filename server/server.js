import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3001;
const TICK_MS = 50;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
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

    if (payload?.position) {
      player.position.x = Number(payload.position.x) || 0;
      player.position.y = Number(payload.position.y) || 1.7;
      player.position.z = Number(payload.position.z) || 0;
    }

    if (typeof payload?.yaw === 'number') {
      player.yaw = payload.yaw;
    }
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
