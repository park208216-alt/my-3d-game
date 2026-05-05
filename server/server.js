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

// ── Game Constants (must match animals.ts) ────────────────────────────────────
const FIELD_LEN = 67.5;
const SPAWN_P1 = 4.0;
const SPAWN_P2 = FIELD_LEN - 4.0;
const MOLE_SURFACE_DETECT = 2.5;
const BASE_HP = 60;
const HP_PER_UPGRADE = 30;
const UPGRADE_COSTS = [10, 15];
const MATCH_DURATION = 120;
const TICK_MS = 50;

const ANIMALS = {
  lion:    { id: 'lion',    layer: 'ground',      attackLayer: 'ground', hp: 25, atk: 10, spd: 1.5, atkCooldown: 1.0,  range: 2.0 },
  elephant:{ id: 'elephant',layer: 'ground',      attackLayer: 'both',   hp: 50, atk: 6,  spd: 1.0, atkCooldown: 1.5,  range: 3.0 },
  eagle:   { id: 'eagle',   layer: 'air',         attackLayer: 'both',   hp: 15, atk: 4,  spd: 2.5, atkCooldown: 0.6,  range: 2.5 },
  monkey:  { id: 'monkey',  layer: 'ground',      attackLayer: 'both',   hp: 20, atk: 2,  spd: 2.0, atkCooldown: 0.75, range: 8.0, ranged: true },
  mole:    { id: 'mole',    layer: 'underground', attackLayer: 'ground', hp: 10, atk: 2,  spd: 5.0, atkCooldown: 0.6,  range: 1.5 },
  bee:     { id: 'bee',     layer: 'air',         attackLayer: 'both',   hp: 1,  atk: 1,  spd: 10,  atkCooldown: 1.5,  range: 4.0, stinger: true },
  bunny:   { id: 'bunny',   layer: 'ground',      attackLayer: 'both',   hp: 3,  atk: 2,  spd: 5,   atkCooldown: 0.75, range: 1.0 },
  cat:     { id: 'cat',     layer: 'ground',      attackLayer: 'ground', hp: 3,  atk: 2,  spd: 6,   atkCooldown: 0.75, range: 2.0, evasion: 0.5 },
  chick:   { id: 'chick',   layer: 'ground',      attackLayer: 'ground', hp: 1,  atk: 0.1,spd: 7,   atkCooldown: 0.3,  range: 1.0 },
  cow:     { id: 'cow',     layer: 'ground',      attackLayer: 'ground', hp: 8,  atk: 1,  spd: 2,   atkCooldown: 3.0,  range: 1.0 },
  crab:    { id: 'crab',    layer: 'ground',      attackLayer: 'ground', hp: 1,  atk: 1,  spd: 2,   atkCooldown: 0.375,range: 1.0 },
  deer:    { id: 'deer',    layer: 'ground',      attackLayer: 'ground', hp: 4,  atk: 3,  spd: 5,   atkCooldown: 0.6,  range: 1.0 },
  dog:     { id: 'dog',     layer: 'ground',      attackLayer: 'ground', hp: 3,  atk: 3,  spd: 6,   atkCooldown: 0.75, range: 1.0 },
  fox:     { id: 'fox',     layer: 'ground',      attackLayer: 'ground', hp: 3,  atk: 2,  spd: 7,   atkCooldown: 1.0,  range: 1.0 },
  giraffe: { id: 'giraffe', layer: 'ground',      attackLayer: 'both',   hp: 4,  atk: 2,  spd: 7,   atkCooldown: 0.43, range: 2.0 },
  hog:     { id: 'hog',     layer: 'ground',      attackLayer: 'ground', hp: 4,  atk: 2,  spd: 9,   atkCooldown: 0.3,  range: 1.0 },
  koala:   { id: 'koala',   layer: 'ground',      attackLayer: 'both',   hp: 2,  atk: 5,  spd: 1,   atkCooldown: 3.0,  range: 3.0, ranged: true },
  panda:   { id: 'panda',   layer: 'ground',      attackLayer: 'ground', hp: 5,  atk: 3,  spd: 2,   atkCooldown: 1.5,  range: 1.0 },
  penguin: { id: 'penguin', layer: 'ground',      attackLayer: 'ground', hp: 2,  atk: 1,  spd: 1,   atkCooldown: 0.6,  range: 1.0 },
  pig:     { id: 'pig',     layer: 'ground',      attackLayer: 'ground', hp: 6,  atk: 1,  spd: 4,   atkCooldown: 1.0,  range: 1.0 },
  polar:   { id: 'polar',   layer: 'ground',      attackLayer: 'ground', hp: 7,  atk: 6,  spd: 5,   atkCooldown: 0.75, range: 2.0 },
  tiger:   { id: 'tiger',   layer: 'ground',      attackLayer: 'ground', hp: 7,  atk: 7,  spd: 7,   atkCooldown: 0.43, range: 2.0, leap: true, leapRange: 5 },
};

// ── Simulation ────────────────────────────────────────────────────────────────
function canAttack(def, enemyDef) {
  if (def.attackLayer === 'ground' && enemyDef.layer === 'air') return false;
  return true;
}

function applyBaseDamage(gs, attackerSide, atk) {
  if (attackerSide === 'p1') gs.p2BaseHp = Math.max(0, gs.p2BaseHp - atk);
  else gs.p1BaseHp = Math.max(0, gs.p1BaseHp - atk);
}

function dealDamage(attacker, target, atk, gs, now) {
  const tDef = ANIMALS[target.animalId];
  // Cat evasion: 50% chance to dodge
  if (tDef && tDef.evasion && Math.random() < tDef.evasion) return;
  // Bee stinger: first attack paralyzes
  const aDef = ANIMALS[attacker.animalId];
  if (aDef && aDef.stinger && attacker.stingerReady) {
    attacker.stingerReady = false;
    target.paralyzedUntil = now + 1.5;
  }
  target.hp = Math.max(0, target.hp - atk);
  if (target.hp <= 0) target.state = 'dead';
}

function isParalyzed(u, now) {
  return u.paralyzedUntil && u.paralyzedUntil > now;
}

function stepGroundOrAir(u, dt, dir, def, enemies, gs, now) {
  if (isParalyzed(u, now)) { u.state = 'moving'; return; }

  const attackable = enemies.filter(e => canAttack(def, ANIMALS[e.animalId]));
  let closest = null, closestDist = Infinity;
  for (const e of attackable) {
    const d = Math.abs(e.z - u.z);
    if (d < closestDist) { closestDist = d; closest = e; }
  }
  const baseZ = u.side === 'p1' ? FIELD_LEN : 0;
  const baseDist = Math.abs(baseZ - u.z);

  // Tiger leap: at 5+ distance, move at leap speed
  if (def.leap && closest && closestDist >= (def.leapRange ?? 5)) {
    u.state = 'moving';
    u.z += dir * def.spd * 3 * dt;
    return;
  }

  if (def.ranged) {
    if (closest && closestDist <= def.range) {
      u.state = 'attacking';
      if (u.atkTimer <= 0) { dealDamage(u, closest, def.atk, gs, now); u.atkTimer = def.atkCooldown; }
      return;
    }
    if (baseDist <= def.range) {
      u.state = 'attacking';
      if (u.atkTimer <= 0) { applyBaseDamage(gs, u.side, def.atk); u.atkTimer = def.atkCooldown; }
      return;
    }
    u.state = 'moving'; u.z += dir * def.spd * dt; return;
  }

  if (closest && closestDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { dealDamage(u, closest, def.atk, gs, now); u.atkTimer = def.atkCooldown; }
    return;
  }
  if (baseDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { applyBaseDamage(gs, u.side, def.atk); u.atkTimer = def.atkCooldown; }
    return;
  }
  u.state = 'moving'; u.z += dir * def.spd * dt;
}

function stepMole(u, dt, dir, enemies, gs) {
  const def = ANIMALS.mole;
  const groundEnemies = enemies.filter(e => ANIMALS[e.animalId].layer !== 'air');
  const baseZ = u.side === 'p1' ? FIELD_LEN : 0;
  const baseDist = Math.abs(baseZ - u.z);

  if (u.state === 'underground') {
    const near = groundEnemies.find(e => Math.abs(e.z - u.z) <= MOLE_SURFACE_DETECT);
    if (near || baseDist <= def.range) { u.state = 'moving'; }
    else { u.z += dir * def.spd * dt; }
    return;
  }

  const nearest = groundEnemies.reduce((best, e) => {
    const d = Math.abs(e.z - u.z);
    return !best || d < Math.abs(best.z - u.z) ? e : best;
  }, null);

  if (nearest && Math.abs(nearest.z - u.z) <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { nearest.hp = Math.max(0, nearest.hp - def.atk); u.atkTimer = def.atkCooldown; if (nearest.hp <= 0) nearest.state = 'dead'; }
    return;
  }
  if (baseDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { applyBaseDamage(gs, u.side, def.atk); u.atkTimer = def.atkCooldown; }
    return;
  }
  if (nearest) { u.state = 'moving'; u.z += dir * def.spd * dt; return; }
  u.state = 'underground';
}

function stepGame(gs) {
  const dt = TICK_MS / 1000;
  const now = gs.elapsed ?? 0;
  gs.elapsed = (gs.elapsed ?? 0) + dt;
  const alive = gs.units.filter(u => u.state !== 'dead');

  for (const u of alive) {
    if (u.state === 'dead') continue;
    u.atkTimer = Math.max(0, u.atkTimer - dt);
    const def = ANIMALS[u.animalId];
    const dir = u.side === 'p1' ? 1 : -1;
    const enemies = alive.filter(e => e.side !== u.side && e.state !== 'underground' && e.state !== 'dead');
    if (def.layer === 'underground') stepMole(u, dt, dir, enemies, gs);
    else stepGroundOrAir(u, dt, dir, def, enemies, gs, now);
  }

  gs.units = gs.units.filter(u => u.state !== 'dead');
}

// ── Room Management ───────────────────────────────────────────────────────────
const battleRooms = new Map();
const socketRoom = new Map();

function startServerGame(roomCode, room) {
  const gs = { units: [], p1BaseHp: BASE_HP, p2BaseHp: BASE_HP, p1MaxHp: BASE_HP, p2MaxHp: BASE_HP, p1UpgradeLevel: 0, p2UpgradeLevel: 0, unitIdCounter: 0, ended: false, timeLeft: MATCH_DURATION };
  room.gameState = gs;

  room.intervalId = setInterval(() => {
    if (gs.ended) return;
    gs.timeLeft = Math.max(0, gs.timeLeft - TICK_MS / 1000);
    stepGame(gs);

    io.to(roomCode).emit('gameState', {
      units: gs.units.map(u => ({ id: u.id, animalId: u.animalId, side: u.side, z: u.z, x: u.x, hp: u.hp, maxHp: u.maxHp, state: u.state, stingerReady: u.stingerReady, paralyzedUntil: u.paralyzedUntil })),
      p1BaseHp: gs.p1BaseHp,
      p2BaseHp: gs.p2BaseHp,
      p1MaxHp: gs.p1MaxHp,
      p2MaxHp: gs.p2MaxHp,
      p1UpgradeLevel: gs.p1UpgradeLevel,
      p2UpgradeLevel: gs.p2UpgradeLevel,
      timeLeft: gs.timeLeft,
    });

    if (gs.p1BaseHp <= 0 || gs.p2BaseHp <= 0 || gs.timeLeft <= 0) {
      gs.ended = true;
      clearInterval(room.intervalId);
      room.intervalId = null;
      let result;
      if (gs.timeLeft <= 0 && gs.p1BaseHp > 0 && gs.p2BaseHp > 0) {
        if (gs.p1BaseHp > gs.p2BaseHp) result = 'p1win';
        else if (gs.p2BaseHp > gs.p1BaseHp) result = 'p2win';
        else result = 'draw';
      } else {
        result = gs.p1BaseHp <= 0 ? 'p2win' : 'p1win';
      }
      io.to(roomCode).emit('gameEnd', { result });
    }
  }, TICK_MS);
}

io.on('connection', (socket) => {

  socket.on('battleJoin', (payload) => {
    const nickname = sanitize(payload?.nickname, 'Player');
    const roomCode = normalizeCode(payload?.roomCode);
    if (!roomCode) { socket.emit('joinError', 'Invalid room code'); return; }

    leaveRoom(socket);

    let room = battleRooms.get(roomCode);
    if (!room) {
      room = { p1: socket.id, p2: null, p1Nick: nickname, p2Nick: '', gameState: null, intervalId: null };
      battleRooms.set(roomCode, room);
      socketRoom.set(socket.id, roomCode);
      socket.join(roomCode);
      socket.emit('waitingForOpponent', { roomCode });
      return;
    }

    if (room.p2 !== null) { socket.emit('joinError', 'Room is full'); return; }

    room.p2 = socket.id;
    room.p2Nick = nickname;
    socketRoom.set(socket.id, roomCode);
    socket.join(roomCode);

    const p1Socket = io.sockets.sockets.get(room.p1);
    if (!p1Socket) {
      room.p1 = socket.id; room.p2 = null; room.p1Nick = nickname;
      socket.emit('waitingForOpponent', { roomCode });
      return;
    }

    const p1Team = Math.random() < 0.5 ? 'red' : 'violet';
    const p2Team = p1Team === 'red' ? 'violet' : 'red';
    p1Socket.emit('battleStart', { side: 'p1', opponentNick: nickname, myTeam: p1Team, foeTeam: p2Team });
    socket.emit('battleStart', { side: 'p2', opponentNick: room.p1Nick, myTeam: p2Team, foeTeam: p1Team });
    startServerGame(roomCode, room);
  });

  socket.on('battleSpawn', (payload) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = battleRooms.get(roomCode);
    if (!room?.gameState || room.gameState.ended) return;
    const animalId = payload?.animalId;
    if (!ANIMALS[animalId]) return;

    const gs = room.gameState;
    const side = room.p1 === socket.id ? 'p1' : 'p2';
    const def = ANIMALS[animalId];
    gs.units.push({
      id: `u${++gs.unitIdCounter}`,
      animalId, side,
      z: side === 'p1' ? SPAWN_P1 : SPAWN_P2,
      x: (Math.random() - 0.5) * 5,
      hp: def.hp, maxHp: def.hp,
      state: def.layer === 'underground' ? 'underground' : 'moving',
      atkTimer: 0,
      stingerReady: def.stinger ? true : undefined,
    });
  });

  socket.on('battleUpgrade', () => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;
    const room = battleRooms.get(roomCode);
    if (!room?.gameState || room.gameState.ended) return;
    const gs = room.gameState;
    const side = room.p1 === socket.id ? 'p1' : 'p2';
    const levelKey = side === 'p1' ? 'p1UpgradeLevel' : 'p2UpgradeLevel';
    const hpKey = side === 'p1' ? 'p1BaseHp' : 'p2BaseHp';
    const maxHpKey = side === 'p1' ? 'p1MaxHp' : 'p2MaxHp';
    const level = gs[levelKey];
    if (level >= 2) return;
    gs[levelKey]++;
    gs[maxHpKey] += HP_PER_UPGRADE;
    gs[hpKey] = Math.min(gs[maxHpKey], gs[hpKey] + HP_PER_UPGRADE);
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
    if (room.intervalId) { clearInterval(room.intervalId); room.intervalId = null; }
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
