import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '';
const ALLOWED_ORIGINS = CLIENT_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, battles: battleRooms.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Zoo Battle server running.');
});

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : true },
});

// battleRooms: roomCode → { p1: socketId|null, p2: socketId|null, p1Nick, p2Nick }
const battleRooms = new Map();
// socketRoom: socketId → roomCode
const socketRoom = new Map();

io.on('connection', (socket) => {

  socket.on('battleJoin', (payload) => {
    const nickname = sanitize(payload?.nickname, 'Player');
    const roomCode = normalizeCode(payload?.roomCode);
    if (!roomCode) { socket.emit('joinError', 'Invalid room code'); return; }

    // Leave any existing room
    leaveRoom(socket);

    let room = battleRooms.get(roomCode);
    if (!room) {
      room = { p1: socket.id, p2: null, p1Nick: nickname, p2Nick: '' };
      battleRooms.set(roomCode, room);
      socketRoom.set(socket.id, roomCode);
      socket.join(roomCode);
      socket.emit('waitingForOpponent', { roomCode });
      return;
    }

    if (room.p2 !== null) { socket.emit('joinError', 'Room is full'); return; }

    // Second player joins — start battle
    room.p2 = socket.id;
    room.p2Nick = nickname;
    socketRoom.set(socket.id, roomCode);
    socket.join(roomCode);

    const p1Socket = io.sockets.sockets.get(room.p1);
    if (!p1Socket) {
      // P1 disconnected while waiting
      room.p1 = socket.id;
      room.p2 = null;
      room.p1Nick = nickname;
      socket.emit('waitingForOpponent', { roomCode });
      return;
    }

    // Tell both players which side they are and start
    p1Socket.emit('battleStart', { side: 'p1', opponentNick: nickname });
    socket.emit('battleStart', { side: 'p2', opponentNick: room.p1Nick });
  });

  // Relay spawn to opponent
  socket.on('battleSpawn', (payload) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    socket.to(roomCode).emit('opponentSpawn', { animalId: payload?.animalId });
  });

  // Relay full game state from host to guest
  socket.on('battleState', (payload) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    socket.to(roomCode).emit('opponentState', payload);
  });

  socket.on('battleResult', (payload) => {
    const roomCode = socketRoom.get(socket.id);
    if (roomCode) socket.to(roomCode).emit('opponentResult', payload);
  });

  socket.on('disconnect', () => {
    const roomCode = socketRoom.get(socket.id);
    if (roomCode) {
      socket.to(roomCode).emit('opponentLeft');
      leaveRoom(socket);
    }
  });
});

function leaveRoom(socket) {
  const roomCode = socketRoom.get(socket.id);
  if (!roomCode) return;
  const room = battleRooms.get(roomCode);
  if (room) {
    if (room.p1 === socket.id) room.p1 = null;
    if (room.p2 === socket.id) room.p2 = null;
    if (!room.p1 && !room.p2) battleRooms.delete(roomCode);
  }
  socket.leave(roomCode);
  socketRoom.delete(socket.id);
}

function sanitize(raw, fallback) {
  const t = String(raw ?? '').trim();
  return t || fallback;
}

function normalizeCode(raw) {
  const c = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c || null;
}

httpServer.listen(PORT, () => {
  console.log(`Zoo Battle server on port ${PORT}`);
});
