import * as THREE from 'three';
import { io } from 'socket.io-client';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.appendChild(renderer.domElement);

const info = document.createElement('div');
info.textContent = 'Click to play (WASD move, Shift run, Space jump, Mouse look)';
info.style.position = 'fixed';
info.style.top = '16px';
info.style.left = '50%';
info.style.transform = 'translateX(-50%)';
info.style.padding = '8px 12px';
info.style.background = 'rgba(0, 0, 0, 0.45)';
info.style.color = '#e8eefc';
info.style.border = '1px solid rgba(255, 255, 255, 0.25)';
info.style.borderRadius = '999px';
info.style.fontFamily = 'system-ui, sans-serif';
info.style.fontSize = '14px';
info.style.zIndex = '20';
document.body.appendChild(info);

const netStatus = document.createElement('div');
netStatus.textContent = 'Connecting to multiplayer server...';
netStatus.style.position = 'fixed';
netStatus.style.top = '54px';
netStatus.style.left = '50%';
netStatus.style.transform = 'translateX(-50%)';
netStatus.style.padding = '6px 10px';
netStatus.style.background = 'rgba(0, 0, 0, 0.35)';
netStatus.style.color = '#b7c5ff';
netStatus.style.border = '1px solid rgba(255, 255, 255, 0.15)';
netStatus.style.borderRadius = '999px';
netStatus.style.fontFamily = 'system-ui, sans-serif';
netStatus.style.fontSize = '12px';
netStatus.style.zIndex = '20';
document.body.appendChild(netStatus);

const roomStatus = document.createElement('div');
roomStatus.textContent = 'Room: - | Players: 0';
roomStatus.style.position = 'fixed';
roomStatus.style.top = '86px';
roomStatus.style.left = '50%';
roomStatus.style.transform = 'translateX(-50%)';
roomStatus.style.padding = '6px 10px';
roomStatus.style.background = 'rgba(0, 0, 0, 0.35)';
roomStatus.style.color = '#c6f3ff';
roomStatus.style.border = '1px solid rgba(255, 255, 255, 0.15)';
roomStatus.style.borderRadius = '999px';
roomStatus.style.fontFamily = 'system-ui, sans-serif';
roomStatus.style.fontSize = '12px';
roomStatus.style.zIndex = '20';
document.body.appendChild(roomStatus);

const combatStatus = document.createElement('div');
combatStatus.textContent = 'HP: 100 | K:0 D:0';
combatStatus.style.position = 'fixed';
combatStatus.style.top = '116px';
combatStatus.style.left = '50%';
combatStatus.style.transform = 'translateX(-50%)';
combatStatus.style.padding = '6px 10px';
combatStatus.style.background = 'rgba(0, 0, 0, 0.35)';
combatStatus.style.color = '#ffd8b0';
combatStatus.style.border = '1px solid rgba(255, 255, 255, 0.15)';
combatStatus.style.borderRadius = '999px';
combatStatus.style.fontFamily = 'system-ui, sans-serif';
combatStatus.style.fontSize = '12px';
combatStatus.style.zIndex = '20';
document.body.appendChild(combatStatus);

const combatFeed = document.createElement('div');
combatFeed.textContent = '';
combatFeed.style.position = 'fixed';
combatFeed.style.bottom = '20px';
combatFeed.style.left = '50%';
combatFeed.style.transform = 'translateX(-50%)';
combatFeed.style.padding = '8px 12px';
combatFeed.style.background = 'rgba(0, 0, 0, 0.45)';
combatFeed.style.color = '#ffe9d2';
combatFeed.style.border = '1px solid rgba(255, 255, 255, 0.2)';
combatFeed.style.borderRadius = '10px';
combatFeed.style.fontFamily = 'system-ui, sans-serif';
combatFeed.style.fontSize = '13px';
combatFeed.style.opacity = '0';
combatFeed.style.transition = 'opacity 0.18s ease';
combatFeed.style.zIndex = '20';
document.body.appendChild(combatFeed);

const crosshair = document.createElement('div');
crosshair.textContent = '+';
crosshair.style.position = 'fixed';
crosshair.style.left = '50%';
crosshair.style.top = '50%';
crosshair.style.transform = 'translate(-50%, -50%)';
crosshair.style.color = '#ffffff';
crosshair.style.fontFamily = 'monospace';
crosshair.style.fontSize = '24px';
crosshair.style.textShadow = '0 0 6px rgba(255,255,255,0.7)';
crosshair.style.pointerEvents = 'none';
crosshair.style.opacity = '0';
crosshair.style.zIndex = '25';
document.body.appendChild(crosshair);

const setupOverlay = document.createElement('div');
setupOverlay.style.position = 'fixed';
setupOverlay.style.inset = '0';
setupOverlay.style.display = 'flex';
setupOverlay.style.alignItems = 'center';
setupOverlay.style.justifyContent = 'center';
setupOverlay.style.background = 'rgba(3, 7, 18, 0.65)';
setupOverlay.style.backdropFilter = 'blur(2px)';
setupOverlay.style.zIndex = '30';
document.body.appendChild(setupOverlay);

const setupPanel = document.createElement('div');
setupPanel.style.width = 'min(92vw, 360px)';
setupPanel.style.padding = '18px';
setupPanel.style.borderRadius = '14px';
setupPanel.style.background = 'rgba(10, 15, 29, 0.9)';
setupPanel.style.border = '1px solid rgba(255, 255, 255, 0.18)';
setupPanel.style.fontFamily = 'system-ui, sans-serif';
setupPanel.style.color = '#e8eefc';
setupOverlay.appendChild(setupPanel);

const setupTitle = document.createElement('div');
setupTitle.textContent = 'Join Multiplayer Room';
setupTitle.style.fontSize = '18px';
setupTitle.style.fontWeight = '700';
setupTitle.style.marginBottom = '12px';
setupPanel.appendChild(setupTitle);

const nicknameInput = document.createElement('input');
nicknameInput.placeholder = 'Nickname';
nicknameInput.value = `Player${Math.floor(Math.random() * 900 + 100)}`;
applyInputStyle(nicknameInput);
setupPanel.appendChild(nicknameInput);

const roomCodeInput = document.createElement('input');
roomCodeInput.placeholder = 'Room code (e.g. ZOO123)';
roomCodeInput.value = 'ZOO123';
roomCodeInput.style.marginTop = '8px';
applyInputStyle(roomCodeInput);
setupPanel.appendChild(roomCodeInput);

const roomCodeActions = document.createElement('div');
roomCodeActions.style.display = 'flex';
roomCodeActions.style.gap = '8px';
roomCodeActions.style.marginTop = '8px';
setupPanel.appendChild(roomCodeActions);

const randomRoomButton = document.createElement('button');
randomRoomButton.textContent = 'Random Code';
applyMiniButtonStyle(randomRoomButton);
roomCodeActions.appendChild(randomRoomButton);

const copyRoomButton = document.createElement('button');
copyRoomButton.textContent = 'Copy Code';
applyMiniButtonStyle(copyRoomButton);
roomCodeActions.appendChild(copyRoomButton);

const joinHint = document.createElement('div');
joinHint.textContent = 'Share same room code to play together.';
joinHint.style.fontSize = '12px';
joinHint.style.opacity = '0.75';
joinHint.style.marginTop = '8px';
setupPanel.appendChild(joinHint);

const joinButton = document.createElement('button');
joinButton.textContent = 'Join Room';
joinButton.style.marginTop = '12px';
joinButton.style.width = '100%';
joinButton.style.padding = '10px 12px';
joinButton.style.borderRadius = '10px';
joinButton.style.border = '1px solid rgba(255, 255, 255, 0.25)';
joinButton.style.background = '#41c1ff';
joinButton.style.color = '#031523';
joinButton.style.fontWeight = '700';
joinButton.style.cursor = 'pointer';
setupPanel.appendChild(joinButton);

const joinError = document.createElement('div');
joinError.style.fontSize = '12px';
joinError.style.color = '#ff9b9b';
joinError.style.marginTop = '8px';
setupPanel.appendChild(joinError);

const remoteTexture = createCheckerTexture();

const hemiLight = new THREE.HemisphereLight(0xaec6ff, 0x1a1a1a, 0.9);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 2);
scene.add(dirLight);

const grid = new THREE.GridHelper(40, 40, 0x2b3355, 0x1e2440);
grid.position.y = 0;
scene.add(grid);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x141a2e, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const obstacle = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x6ee7ff, roughness: 0.35, metalness: 0.1 })
);
obstacle.position.set(0, 1, -6);
scene.add(obstacle);

const playerPosition = new THREE.Vector3(0, 1.7, 6);
camera.position.copy(playerPosition);
let localPlayerId = '';
let localNickname = nicknameInput.value;
let currentRoomCode = '';
let playerCount = 0;
let hasJoinedRoom = false;
let localHp = 100;
let localKills = 0;
let localDeaths = 0;

const keys = new Set<string>();
window.addEventListener('keydown', (event) => keys.add(event.code));
window.addEventListener('keyup', (event) => keys.delete(event.code));

let yaw = Math.PI;
let pitch = 0;
const lookSensitivity = 0.0022;
const maxPitch = Math.PI / 2 - 0.05;

let velocityY = 0;
let canJump = true;
const gravity = 26;
const walkSpeed = 5.4;
const runSpeed = 9.4;
const jumpSpeed = 9.5;

const clock = new THREE.Clock();
type RemotePlayer = {
  mesh: THREE.Mesh;
  targetPosition: THREE.Vector3;
  targetYaw: number;
  labelSprite: THREE.Sprite;
  labelText: string;
};
const remotePlayers = new Map<string, RemotePlayer>();
let sendAccumulator = 0;
let shootCooldown = 0;

const socketUrl =
  (import.meta.env.VITE_SOCKET_URL as string | undefined) ??
  window.location.origin;
const socket = io(socketUrl, {
  path: '/socket.io',
  transports: ['websocket'],
});

socket.on('connect', () => {
  localPlayerId = socket.id ?? localPlayerId;
  netStatus.textContent = 'Socket connected. Join a room to start.';
});

socket.on('disconnect', () => {
  hasJoinedRoom = false;
  netStatus.textContent = 'Disconnected from server';
  setupOverlay.style.display = 'flex';
});

type NetPlayer = {
  id: string;
  nickname: string;
  roomCode: string;
  position: { x: number; y: number; z: number };
  yaw: number;
  hp: number;
  kills: number;
  deaths: number;
  isAlive: boolean;
};

socket.on('bootstrap', (payload: { id: string; roomCode: string; players: NetPlayer[] }) => {
  localPlayerId = payload.id;
  currentRoomCode = payload.roomCode;
  hasJoinedRoom = true;
  setupOverlay.style.display = 'none';
  netStatus.textContent = `Connected as ${localNickname}`;
  syncRemotePlayers(payload.players);
  syncLocalCombatStats(payload.players);
  setRoomStatus(currentRoomCode, payload.players.length);
});

socket.on('playerJoined', (player: NetPlayer) => {
  syncRemotePlayers([player]);
});

socket.on('playerLeft', (id: string) => {
  const remote = remotePlayers.get(id);
  if (!remote) return;
  scene.remove(remote.mesh);
  remote.mesh.geometry.dispose();
  const material = remote.mesh.material;
  if (material instanceof THREE.Material) {
    material.dispose();
  }
  remotePlayers.delete(id);
});

socket.on('worldState', (players: NetPlayer[]) => {
  syncRemotePlayers(players);
  syncLocalCombatStats(players);
  setRoomStatus(currentRoomCode, players.length);
});

socket.on('roomInfo', (payload: { roomCode: string; count: number }) => {
  if (!payload || payload.roomCode !== currentRoomCode) return;
  setRoomStatus(payload.roomCode, payload.count);
});

socket.on('joinError', (message: string) => {
  joinError.style.color = '#ff9b9b';
  joinError.textContent = message;
});

socket.on('damageTaken', (payload: { by: string; hp: number }) => {
  localHp = payload.hp;
  updateCombatStatus();
  flashCombatFeed(`Hit by ${payload.by} (${payload.hp} HP left)`);
});

socket.on(
  'playerDied',
  (payload: { killerId: string; killerName: string; victimId: string; victimName: string }) => {
    if (!payload) return;
    flashCombatFeed(`${payload.killerName} eliminated ${payload.victimName}`);
  }
);

socket.on('playerRespawn', (payload: { position: { x: number; y: number; z: number } }) => {
  if (!payload?.position) return;
  playerPosition.set(payload.position.x, payload.position.y, payload.position.z);
  velocityY = 0;
  canJump = true;
  localHp = 100;
  updateCombatStatus();
  flashCombatFeed('Respawned');
});

renderer.domElement.addEventListener('click', () => {
  if (!hasJoinedRoom) return;
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  info.style.display = locked ? 'none' : 'block';
  crosshair.style.opacity = locked ? '0.9' : '0';
});

document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== renderer.domElement) return;

  yaw -= event.movementX * lookSensitivity;
  pitch -= event.movementY * lookSensitivity;
  pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
});

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  if (!hasJoinedRoom || shootCooldown > 0) return;
  if (document.pointerLockElement !== renderer.domElement) return;

  shootCooldown = 0.18;
  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  socket.emit('shoot', {
    origin: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
  });
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.033);
  shootCooldown = Math.max(0, shootCooldown - dt);

  const moveForward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const moveRight = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const isRunning = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = isRunning ? runSpeed : walkSpeed;

  const inputVector = new THREE.Vector2(moveRight, moveForward);
  if (inputVector.lengthSq() > 1) inputVector.normalize();

  // Camera looks down -Z in Three.js, so forward should align with that.
  const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  playerPosition.addScaledVector(forward, inputVector.y * speed * dt);
  playerPosition.addScaledVector(right, inputVector.x * speed * dt);

  const jumpPressed = keys.has('Space');
  if (jumpPressed && canJump) {
    velocityY = jumpSpeed;
    canJump = false;
  }

  velocityY -= gravity * dt;
  playerPosition.y += velocityY * dt;
  if (playerPosition.y <= 1.7) {
    playerPosition.y = 1.7;
    velocityY = 0;
    canJump = true;
  }

  camera.position.copy(playerPosition);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = 0;

  sendAccumulator += dt;
  if (socket.connected && hasJoinedRoom && sendAccumulator >= 0.05) {
    sendAccumulator = 0;
    socket.emit('playerUpdate', {
      position: {
        x: playerPosition.x,
        y: playerPosition.y,
        z: playerPosition.z,
      },
      yaw,
    });
  }

  for (const remote of remotePlayers.values()) {
    if (!remote.mesh.visible) {
      remote.labelSprite.visible = false;
      continue;
    }
    remote.mesh.position.lerp(remote.targetPosition, 1 - Math.exp(-14 * dt));
    remote.mesh.rotation.y += (remote.targetYaw - remote.mesh.rotation.y) * (1 - Math.exp(-14 * dt));
    remote.labelSprite.position.set(
      remote.mesh.position.x,
      remote.mesh.position.y + 1.6,
      remote.mesh.position.z
    );
    remote.labelSprite.lookAt(camera.position);
  }

  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

joinButton.addEventListener('click', () => {
  joinError.style.color = '#ff9b9b';
  joinError.textContent = '';
  const nickname = nicknameInput.value.trim().slice(0, 16);
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  roomCodeInput.value = roomCode;
  if (!nickname) {
    joinError.textContent = 'Please enter a nickname.';
    return;
  }
  if (!roomCode) {
    joinError.textContent = 'Please enter a room code.';
    return;
  }
  localNickname = nickname;
  localHp = 100;
  localKills = 0;
  localDeaths = 0;
  updateCombatStatus();
  if (socket.connected) {
    socket.emit('joinRoom', { nickname, roomCode });
  } else {
    socket.connect();
    socket.once('connect', () => {
      socket.emit('joinRoom', { nickname, roomCode });
    });
  }
});

randomRoomButton.addEventListener('click', () => {
  roomCodeInput.value = makeRoomCode();
  joinError.textContent = '';
});

copyRoomButton.addEventListener('click', async () => {
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  roomCodeInput.value = roomCode;
  if (!roomCode) {
    joinError.textContent = 'Enter room code first.';
    return;
  }

  try {
    await navigator.clipboard.writeText(roomCode);
    joinError.style.color = '#9dffbc';
    joinError.textContent = 'Room code copied.';
  } catch {
    joinError.style.color = '#ff9b9b';
    joinError.textContent = 'Clipboard blocked. Copy manually.';
  }
});

roomCodeInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  joinButton.click();
});

nicknameInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  joinButton.click();
});

function syncRemotePlayers(players: NetPlayer[]) {
  const presentIds = new Set<string>();
  for (const player of players) {
    if (!player || player.id === localPlayerId) continue;
    presentIds.add(player.id);

    let remote = remotePlayers.get(player.id);
    if (!remote) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 2, 1),
        new THREE.MeshStandardMaterial({
          map: remoteTexture,
          color: 0xfff1e8,
          roughness: 0.5,
          metalness: 0.03,
        })
      );
      mesh.position.set(player.position.x, Math.max(1, player.position.y - 0.7), player.position.z);
      mesh.castShadow = true;
      const labelSprite = createNameTag(player.nickname);
      labelSprite.position.set(mesh.position.x, mesh.position.y + 1.6, mesh.position.z);
      scene.add(mesh);
      scene.add(labelSprite);
      remote = {
        mesh,
        targetPosition: mesh.position.clone(),
        targetYaw: player.yaw,
        labelSprite,
        labelText: player.nickname,
      };
      remotePlayers.set(player.id, remote);
    }

    if (remote.labelText !== player.nickname) {
      updateNameTag(remote.labelSprite, player.nickname);
      remote.labelText = player.nickname;
    }

    remote.mesh.visible = player.isAlive;
    remote.labelSprite.visible = player.isAlive;
    if (!player.isAlive) continue;

    remote.targetPosition.set(player.position.x, Math.max(1, player.position.y - 0.7), player.position.z);
    remote.targetYaw = player.yaw;
  }

  for (const [id, remote] of remotePlayers.entries()) {
    if (presentIds.has(id)) continue;
    scene.remove(remote.mesh);
    scene.remove(remote.labelSprite);
    remote.mesh.geometry.dispose();
    const material = remote.mesh.material;
    if (material instanceof THREE.Material) material.dispose();
    const spriteMaterial = remote.labelSprite.material;
    if (spriteMaterial instanceof THREE.SpriteMaterial && spriteMaterial.map) spriteMaterial.map.dispose();
    if (spriteMaterial instanceof THREE.Material) spriteMaterial.dispose();
    remotePlayers.delete(id);
  }
}

function setRoomStatus(roomCode: string, count: number) {
  if (!roomCode) return;
  playerCount = count;
  roomStatus.textContent = `Room: ${roomCode} | Players: ${playerCount}`;
}

function syncLocalCombatStats(players: NetPlayer[]) {
  const me = players.find((player) => player.id === localPlayerId);
  if (!me) return;
  localHp = me.hp;
  localKills = me.kills;
  localDeaths = me.deaths;
  updateCombatStatus();
}

function updateCombatStatus() {
  combatStatus.textContent = `HP: ${Math.max(0, Math.floor(localHp))} | K:${localKills} D:${localDeaths}`;
}

let combatFeedTimer: number | null = null;
function flashCombatFeed(message: string) {
  combatFeed.textContent = message;
  combatFeed.style.opacity = '1';
  if (combatFeedTimer !== null) {
    window.clearTimeout(combatFeedTimer);
  }
  combatFeedTimer = window.setTimeout(() => {
    combatFeed.style.opacity = '0';
  }, 1400);
}

function createNameTag(name: string) {
  const texture = createNameTagTexture(name);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.5, 1);
  return sprite;
}

function updateNameTag(sprite: THREE.Sprite, name: string) {
  const material = sprite.material;
  if (!(material instanceof THREE.SpriteMaterial)) return;
  if (material.map) material.map.dispose();
  material.map = createNameTagTexture(name);
  material.needsUpdate = true;
}

function createNameTagTexture(name: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 72;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);

  ctx.fillStyle = 'rgba(7, 12, 26, 0.72)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 16), canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function applyInputStyle(input: HTMLInputElement) {
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.padding = '10px 12px';
  input.style.borderRadius = '10px';
  input.style.border = '1px solid rgba(255, 255, 255, 0.22)';
  input.style.background = 'rgba(255, 255, 255, 0.05)';
  input.style.color = '#e8eefc';
  input.style.outline = 'none';
}

function applyMiniButtonStyle(button: HTMLButtonElement) {
  button.style.flex = '1';
  button.style.padding = '8px 10px';
  button.style.borderRadius = '8px';
  button.style.border = '1px solid rgba(255, 255, 255, 0.22)';
  button.style.background = 'rgba(255, 255, 255, 0.08)';
  button.style.color = '#e8eefc';
  button.style.fontWeight = '600';
  button.style.cursor = 'pointer';
}

function normalizeRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createCheckerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const size = 16;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const isDark = (x + y) % 2 === 0;
      ctx.fillStyle = isDark ? '#ff8f5a' : '#ffd8be';
      ctx.fillRect(x * size, y * size, size, size);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}