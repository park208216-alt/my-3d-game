import { createServer } from 'node:http';
import { Server } from 'socket.io';

const PORT = Number(process.env.PORT) || 3001;
const TICK_MS = 50;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: players.size }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Socket server is running.');
});
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
  },
});

const players = new Map();

io.on('connection', (socket) => {
  const spawn = randomSpawn();
  players.set(socket.id, {
    id: socket.id,
    position: { x: spawn.x, y: 1.7, z: spawn.z },
    yaw: Math.PI,
  });

  socket.emit('bootstrap', {
    id: socket.id,
    players: Array.from(players.values()),
  });

  socket.broadcast.emit('playerJoined', players.get(socket.id));

  socket.on('playerUpdate', (payload) => {
    const player = players.get(socket.id);
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
    players.delete(socket.id);
    io.emit('playerLeft', socket.id);
  });
});

setInterval(() => {
  io.emit('worldState', Array.from(players.values()));
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Multiplayer server running on port ${PORT} (origin: ${CLIENT_ORIGIN})`);
});

function randomSpawn() {
  const spread = 10;
  return {
    x: (Math.random() - 0.5) * spread,
    z: (Math.random() - 0.5) * spread,
  };
}
