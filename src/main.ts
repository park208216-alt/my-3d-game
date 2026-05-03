import * as THREE from 'three';
import { io } from 'socket.io-client';
import { wordList } from './words';
import type { WordEntry } from './words';

// ─── Scene ───────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
scene.add(camera); // needed for camera children (book mesh) to have world matrix

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.style.touchAction = 'none';
document.body.style.overscrollBehavior = 'none';
document.body.appendChild(renderer.domElement);

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });

// ─── Types ────────────────────────────────────────────────────────────────────
type ControlMode = 'pc' | 'mobile';
type NetPlayer = {
  id: string; nickname: string; roomCode: string;
  position: { x: number; y: number; z: number };
  yaw: number; hp: number; kills: number; deaths: number; isAlive: boolean;
};
type RemotePlayer = {
  mesh: THREE.Mesh; targetPosition: THREE.Vector3; targetYaw: number;
  labelSprite: THREE.Sprite; labelText: string;
};
type KillEffect = { sprite: THREE.Sprite; age: number };
type EnemyMark = {
  targetId: string; english: string; korean: string;
  expiresAt: number; sprite: THREE.Sprite; lastUpdate: number;
};

// ─── Top-left HUD ────────────────────────────────────────────────────────────
const hudLeft = document.createElement('div');
hudLeft.style.cssText = 'position:fixed;top:10px;left:10px;display:flex;flex-direction:column;gap:4px;z-index:20;pointer-events:none;';
document.body.appendChild(hudLeft);

function makeHudLabel(color = '#e8eefc'): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `padding:5px 9px;background:rgba(0,0,0,0.45);color:${color};border:1px solid rgba(255,255,255,0.18);border-radius:8px;font-family:system-ui,sans-serif;font-size:12px;white-space:nowrap;`;
  return el;
}

const info = makeHudLabel('#e8eefc');
info.textContent = 'Click to play (WASD move, Shift run, Space jump, Mouse look)';
info.style.pointerEvents = 'auto';
hudLeft.appendChild(info);

const netStatus = makeHudLabel('#b7c5ff');
netStatus.textContent = 'Connecting to multiplayer server...';
hudLeft.appendChild(netStatus);

const roomStatus = makeHudLabel('#c6f3ff');
roomStatus.textContent = 'Room: - | Players: 0';
hudLeft.appendChild(roomStatus);

const combatStatus = makeHudLabel('#ffd8b0');
combatStatus.textContent = 'HP: 100 | K:0 D:0';
hudLeft.appendChild(combatStatus);

const bulletStatus = makeHudLabel('#aaffcc');
bulletStatus.textContent = '기본: 0  특수: 0  스턴: 0';
hudLeft.appendChild(bulletStatus);

// ─── Top-center: English word + typing input ──────────────────────────────────
const wordDisplay = document.createElement('div');
wordDisplay.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:8px 20px;background:rgba(0,0,0,0.55);color:#ffffff;border:1px solid rgba(255,255,255,0.3);border-radius:12px;font-family:system-ui,sans-serif;font-size:22px;font-weight:700;letter-spacing:1px;z-index:20;text-align:center;display:none;';
document.body.appendChild(wordDisplay);

const typingContainer = document.createElement('div');
typingContainer.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:21;display:none;flex-direction:column;align-items:center;gap:4px;';
document.body.appendChild(typingContainer);

const typingInput = document.createElement('input');
typingInput.placeholder = '한글 뜻 입력 후 Enter';
typingInput.style.cssText = 'width:220px;padding:8px 12px;border-radius:10px;border:1.5px solid rgba(120,200,255,0.7);background:rgba(10,20,40,0.85);color:#ffffff;font-family:system-ui,sans-serif;font-size:15px;outline:none;text-align:center;box-sizing:border-box;';
typingContainer.appendChild(typingInput);

const typingError = document.createElement('div');
typingError.style.cssText = 'color:#ff8888;font-family:system-ui,sans-serif;font-size:12px;opacity:0;transition:opacity 0.2s;';
typingContainer.appendChild(typingError);

// ─── Top-right: Korean choices ────────────────────────────────────────────────
const choicesPanel = document.createElement('div');
choicesPanel.style.cssText = 'position:fixed;top:12px;right:12px;display:none;flex-direction:column;gap:6px;z-index:20;min-width:220px;max-width:300px;';
document.body.appendChild(choicesPanel);

const choiceEls: HTMLDivElement[] = [];
for (let i = 0; i < 3; i++) {
  const el = document.createElement('div');
  el.style.cssText = 'padding:7px 12px;background:rgba(0,0,0,0.55);color:#e8eefc;border:1px solid rgba(255,255,255,0.18);border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;cursor:default;';
  choicesPanel.appendChild(el);
  choiceEls.push(el);
}

// ─── Crosshair ───────────────────────────────────────────────────────────────
const crosshair = document.createElement('div');
crosshair.textContent = '+';
crosshair.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);color:#fff;font-family:monospace;font-size:24px;text-shadow:0 0 6px rgba(255,255,255,0.7);pointer-events:none;opacity:0;z-index:25;';
document.body.appendChild(crosshair);

// ─── Combat feed ─────────────────────────────────────────────────────────────
const combatFeed = document.createElement('div');
combatFeed.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:8px 12px;background:rgba(0,0,0,0.45);color:#ffe9d2;border:1px solid rgba(255,255,255,0.2);border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;opacity:0;transition:opacity 0.18s ease;z-index:20;pointer-events:none;';
document.body.appendChild(combatFeed);

// ─── Mode switch buttons (top-right above choices when room joined) ────────────
const modeSwitch = document.createElement('div');
modeSwitch.style.cssText = 'position:fixed;bottom:16px;right:16px;display:flex;gap:6px;z-index:26;';
document.body.appendChild(modeSwitch);

const pcModeButton = document.createElement('button');
pcModeButton.textContent = 'PC';
applyMiniButtonStyle(pcModeButton);
modeSwitch.appendChild(pcModeButton);

const mobileModeButton = document.createElement('button');
mobileModeButton.textContent = 'Mobile';
applyMiniButtonStyle(mobileModeButton);
modeSwitch.appendChild(mobileModeButton);

// ─── Mobile HUD ───────────────────────────────────────────────────────────────
const mobileHud = document.createElement('div');
mobileHud.style.cssText = 'position:fixed;inset:0;z-index:24;pointer-events:none;display:none;';
document.body.appendChild(mobileHud);

// Joystick
const joystickBase = document.createElement('div');
joystickBase.style.cssText = 'position:absolute;left:20px;bottom:20px;width:120px;height:120px;border-radius:999px;background:rgba(255,255,255,0.08);border:2px solid rgba(255,255,255,0.2);pointer-events:auto;touch-action:none;';
mobileHud.appendChild(joystickBase);

const joystickKnob = document.createElement('div');
joystickKnob.style.cssText = 'position:absolute;left:50%;top:50%;width:50px;height:50px;border-radius:999px;background:rgba(148,214,255,0.85);transform:translate(-50%,-50%);pointer-events:none;';
joystickBase.appendChild(joystickKnob);

// Right-side mobile buttons grid
const mobileButtons = document.createElement('div');
mobileButtons.style.cssText = 'position:absolute;right:14px;bottom:14px;display:grid;grid-template-columns:repeat(3,66px);grid-auto-rows:52px;gap:8px;pointer-events:auto;';
mobileHud.appendChild(mobileButtons);

const mobileRunButton = createActionButton('RUN');
const mobileJumpButton = createActionButton('JUMP');
const mobileFireButton = createActionButton('FIRE');
const mobileSpecButton = createActionButton('SPEC');
mobileSpecButton.style.color = '#aaf0ff';
const mobileStunButton = createActionButton('STUN');
mobileStunButton.style.color = '#ccffaa';
const mobileTypeButton = createActionButton('TYPE');
mobileTypeButton.style.color = '#ffe08a';

mobileButtons.appendChild(mobileRunButton);
mobileButtons.appendChild(mobileJumpButton);
mobileButtons.appendChild(mobileFireButton);
mobileButtons.appendChild(mobileSpecButton);
mobileButtons.appendChild(mobileStunButton);
mobileButtons.appendChild(mobileTypeButton);

// Mobile 1/2/3 answer buttons (center-right, above main buttons)
const mobileAnswerRow = document.createElement('div');
mobileAnswerRow.style.cssText = 'position:absolute;right:14px;bottom:130px;display:flex;gap:8px;pointer-events:auto;';
mobileHud.appendChild(mobileAnswerRow);

const mobileAns: HTMLButtonElement[] = [];
for (let i = 0; i < 3; i++) {
  const btn = createActionButton(`${i + 1}`);
  btn.style.width = '66px';
  btn.style.height = '52px';
  btn.style.fontSize = '18px';
  btn.style.fontWeight = '700';
  mobileAnswerRow.appendChild(btn);
  mobileAns.push(btn);
}

// ─── Setup overlay ────────────────────────────────────────────────────────────
const setupOverlay = document.createElement('div');
setupOverlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,7,18,0.65);backdrop-filter:blur(2px);z-index:30;';
document.body.appendChild(setupOverlay);

const setupPanel = document.createElement('div');
setupPanel.style.cssText = 'width:min(92vw,360px);padding:18px;border-radius:14px;background:rgba(10,15,29,0.9);border:1px solid rgba(255,255,255,0.18);font-family:system-ui,sans-serif;color:#e8eefc;';
setupOverlay.appendChild(setupPanel);

const setupTitle = document.createElement('div');
setupTitle.textContent = 'Join Multiplayer Room';
setupTitle.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:12px;';
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
roomCodeActions.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
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
joinHint.style.cssText = 'font-size:12px;opacity:0.75;margin-top:8px;';
setupPanel.appendChild(joinHint);

const joinButton = document.createElement('button');
joinButton.textContent = 'Join Room';
joinButton.style.cssText = 'margin-top:12px;width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.25);background:#41c1ff;color:#031523;font-weight:700;cursor:pointer;';
setupPanel.appendChild(joinButton);

const joinError = document.createElement('div');
joinError.style.cssText = 'font-size:12px;color:#ff9b9b;margin-top:8px;';
setupPanel.appendChild(joinError);

// ─── Scene Objects ────────────────────────────────────────────────────────────
const remoteTexture = createCheckerTexture();

scene.add(new THREE.HemisphereLight(0xaec6ff, 0x1a1a1a, 0.9));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(5, 10, 2);
scene.add(dirLight);

scene.add(new THREE.GridHelper(40, 40, 0x2b3355, 0x1e2440));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x141a2e, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const obstacle = new THREE.Mesh(
  new THREE.BoxGeometry(2, 2, 2),
  new THREE.MeshStandardMaterial({ color: 0x6ee7ff, roughness: 0.35, metalness: 0.1 })
);
obstacle.position.set(0, 1, -6);
scene.add(obstacle);

// ─── Book / Pen (first-person, camera child) ──────────────────────────────────
const bookGroup = new THREE.Group();
bookGroup.position.set(0.28, -0.26, -0.55);
bookGroup.rotation.set(0.15, -0.2, 0.05);
camera.add(bookGroup);

const bookMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.18, 0.24, 0.025),
  new THREE.MeshStandardMaterial({ color: 0x1a3a6b, roughness: 0.6, metalness: 0.1 })
);
bookGroup.add(bookMesh);

// Book spine detail
const spineMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.015, 0.24, 0.028),
  new THREE.MeshStandardMaterial({ color: 0x0d2247, roughness: 0.7 })
);
spineMesh.position.x = -0.082;
bookGroup.add(spineMesh);

// Pen
const penMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.012, 0.16, 0.012),
  new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 })
);
penMesh.position.set(0.11, 0.02, 0.022);
penMesh.rotation.z = 0.3;
bookGroup.add(penMesh);

// Pen tip
const penTip = new THREE.Mesh(
  new THREE.BoxGeometry(0.008, 0.025, 0.008),
  new THREE.MeshStandardMaterial({ color: 0xd4a030, roughness: 0.4 })
);
penTip.position.set(0.11, -0.092, 0.022);
penTip.rotation.z = 0.3;
bookGroup.add(penTip);

let attackAnimTime = 0;
const bookRestPos = new THREE.Vector3(0.28, -0.26, -0.55);
const bookRestRot = new THREE.Euler(0.15, -0.2, 0.05);

// ─── Player / Game State ──────────────────────────────────────────────────────
const playerPosition = new THREE.Vector3(0, 1.7, 6);
camera.position.copy(playerPosition);

let localPlayerId = '';
let localNickname = nicknameInput.value;
let currentRoomCode = '';
let hasJoinedRoom = false;
let localHp = 100;
let localKills = 0;
let localDeaths = 0;

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

let isFrozen = false;
let frozenUntil = 0;

const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

const prefersTouchInput = window.matchMedia('(pointer: coarse)').matches;
let controlMode: ControlMode = prefersTouchInput ? 'mobile' : 'pc';
let mobileMoveX = 0;
let mobileMoveY = 0;
let mobileRunPressed = false;
let mobileJumpQueued = false;
let joystickPointerId: number | null = null;
let mobileLookPointerId: number | null = null;
let mobileLookLastX = 0;
let mobileLookLastY = 0;

const remotePlayers = new Map<string, RemotePlayer>();
let sendAccumulator = 0;
let basicShootCooldown = 0;
let specialShootCooldown = 0;
let nonLethalShootCooldown = 0;

// ─── Word Quiz State ──────────────────────────────────────────────────────────
let currentWord: WordEntry | null = null;
let currentChoices: string[] = []; // 3 korean strings, shuffled
let correctChoiceIndex = -1;       // which index (0-2) is the correct answer

let isTypingMode = false;

// ─── Bullet State ─────────────────────────────────────────────────────────────
let basicBullets = 0;
let specialBullets = 0;
let nonLethalBullets = 0;

// ─── Kill Effects ─────────────────────────────────────────────────────────────
const killEffects: KillEffect[] = [];

// ─── Enemy Marks (/  above enemies who were answer-wronged) ──────────────────
const enemyMarks = new Map<string, EnemyMark>();

// ─── Socket ───────────────────────────────────────────────────────────────────
const socketUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? window.location.origin;
const socket = io(socketUrl, { path: '/socket.io', transports: ['websocket'] });

socket.on('connect', () => {
  localPlayerId = socket.id ?? localPlayerId;
  netStatus.textContent = 'Socket connected. Join a room to start.';
});

socket.on('disconnect', () => {
  hasJoinedRoom = false;
  netStatus.textContent = 'Disconnected from server';
  setupOverlay.style.display = 'flex';
  wordDisplay.style.display = 'none';
  choicesPanel.style.display = 'none';
});

socket.on('bootstrap', (payload: { id: string; roomCode: string; players: NetPlayer[] }) => {
  localPlayerId = payload.id;
  currentRoomCode = payload.roomCode;
  hasJoinedRoom = true;
  setupOverlay.style.display = 'none';
  netStatus.textContent = `Connected as ${localNickname}`;
  syncRemotePlayers(payload.players);
  syncLocalCombatStats(payload.players);
  setRoomStatus(currentRoomCode, payload.players.length);
  pickNewWord();
  wordDisplay.style.display = 'block';
  choicesPanel.style.display = 'flex';
});

socket.on('playerJoined', (player: NetPlayer) => {
  syncRemotePlayers([player]);
});

socket.on('playerLeft', (id: string) => {
  const remote = remotePlayers.get(id);
  if (!remote) return;
  scene.remove(remote.mesh);
  scene.remove(remote.labelSprite);
  remote.mesh.geometry.dispose();
  if (remote.mesh.material instanceof THREE.Material) remote.mesh.material.dispose();
  const sm = remote.labelSprite.material;
  if (sm instanceof THREE.SpriteMaterial && sm.map) sm.map.dispose();
  if (sm instanceof THREE.Material) sm.dispose();
  remotePlayers.delete(id);

  // remove any mark on this player
  const mark = enemyMarks.get(id);
  if (mark) { scene.remove(mark.sprite); enemyMarks.delete(id); }
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
  flashCombatFeed(`${payload.by}에게 피격 (HP ${payload.hp})`);
});

socket.on('playerDied', (payload: {
  killerId: string; killerName: string;
  victimId: string; victimName: string;
  killEffect: 'circle' | 'triangle';
}) => {
  if (!payload) return;
  flashCombatFeed(`${payload.killerName}이(가) ${payload.victimName} 제거`);

  // Show kill effect at victim position
  const victim = remotePlayers.get(payload.victimId);
  if (victim) {
    spawnKillEffect(victim.mesh.position.clone(), payload.killEffect);
  }

  // Remove any mark on the dead player
  const mark = enemyMarks.get(payload.victimId);
  if (mark) { scene.remove(mark.sprite); enemyMarks.delete(payload.victimId); }
});

socket.on('playerRespawn', (payload: { position: { x: number; y: number; z: number } }) => {
  if (!payload?.position) return;
  playerPosition.set(payload.position.x, payload.position.y, payload.position.z);
  velocityY = 0;
  canJump = true;
  localHp = 100;
  updateCombatStatus();
  flashCombatFeed('리스폰');
});

socket.on('shotMissed', () => {
  nonLethalBullets += 1;
  updateBulletDisplay();
});

socket.on('playerFrozen', () => {
  isFrozen = true;
  frozenUntil = performance.now() + 1000;
  flashCombatFeed('얼어붙었다! (1초)');
});

socket.on('enemyMarked', (payload: {
  targetId: string; english: string; korean: string; expiresAt: number;
}) => {
  if (!payload) return;
  addEnemyMark(payload.targetId, payload.english, payload.korean, payload.expiresAt);
});

// ─── Control Mode ─────────────────────────────────────────────────────────────
pcModeButton.addEventListener('click', () => setControlMode('pc'));
mobileModeButton.addEventListener('click', () => setControlMode('mobile'));
setControlMode(controlMode);

// ─── PC Input ─────────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('click', () => {
  if (controlMode !== 'pc' || !hasJoinedRoom || isTypingMode) return;
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  info.style.display = (controlMode === 'pc' && !locked) ? 'block' : 'none';
  crosshair.style.opacity = (controlMode === 'mobile' || locked) ? '0.9' : '0';
});

document.addEventListener('mousemove', (e) => {
  if (controlMode !== 'pc' || document.pointerLockElement !== renderer.domElement || isTypingMode) return;
  yaw -= e.movementX * lookSensitivity;
  pitch -= e.movementY * lookSensitivity;
  pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
});

document.addEventListener('mousedown', (e) => {
  if (controlMode !== 'pc' || !hasJoinedRoom || isTypingMode) return;
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 0) attemptShoot();
  if (e.button === 2) attemptSpecialShoot();
});

document.addEventListener('contextmenu', (e) => {
  if (controlMode === 'pc' && document.pointerLockElement === renderer.domElement) e.preventDefault();
});

// Keyboard: 1/2/3 answer, T type mode, E nonlethal
window.addEventListener('keydown', (e) => {
  if (isTypingMode) return;
  if (!hasJoinedRoom) return;

  if (e.code === 'Digit1') submitAnswerByIndex(0);
  else if (e.code === 'Digit2') submitAnswerByIndex(1);
  else if (e.code === 'Digit3') submitAnswerByIndex(2);
  else if (e.code === 'KeyT') enterTypingMode();
  else if (e.code === 'KeyE') attemptNonLethalShoot();
});

// ─── Typing Mode ──────────────────────────────────────────────────────────────
function enterTypingMode() {
  if (!hasJoinedRoom || !currentWord) return;
  isTypingMode = true;
  typingInput.value = '';
  typingError.style.opacity = '0';
  typingContainer.style.display = 'flex';
  setTimeout(() => typingInput.focus(), 50);
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

function exitTypingMode() {
  isTypingMode = false;
  typingContainer.style.display = 'none';
  typingInput.value = '';
  typingError.style.opacity = '0';
}

typingInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Escape') { exitTypingMode(); return; }
  if (e.code !== 'Enter') return;

  const typed = typingInput.value.trim();
  if (!typed || !currentWord) return;

  const correct = currentWord.answers.some(
    (a) => a.trim() === typed || a.trim().replace(/\s/g, '') === typed.replace(/\s/g, '')
  );

  if (correct) {
    specialBullets += 1;
    updateBulletDisplay();
    exitTypingMode();
    pickNewWord();
    triggerAttackAnim();
  } else {
    typingError.textContent = '틀렸습니다';
    typingError.style.opacity = '1';
    setTimeout(() => {
      typingError.style.opacity = '0';
    }, 1000);
    typingInput.value = '';
  }
});

// ─── Mobile Input ─────────────────────────────────────────────────────────────
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (controlMode !== 'mobile' || !hasJoinedRoom || isTypingMode) return;
  if (e.clientX < window.innerWidth * 0.38) return;
  mobileLookPointerId = e.pointerId;
  mobileLookLastX = e.clientX;
  mobileLookLastY = e.clientY;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (controlMode !== 'mobile' || mobileLookPointerId !== e.pointerId || isTypingMode) return;
  yaw -= (e.clientX - mobileLookLastX) * lookSensitivity;
  pitch -= (e.clientY - mobileLookLastY) * lookSensitivity;
  pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
  mobileLookLastX = e.clientX;
  mobileLookLastY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => { if (mobileLookPointerId === e.pointerId) mobileLookPointerId = null; });
renderer.domElement.addEventListener('pointercancel', (e) => { if (mobileLookPointerId === e.pointerId) mobileLookPointerId = null; });

joystickBase.addEventListener('pointerdown', (e) => {
  if (controlMode !== 'mobile') return;
  joystickPointerId = e.pointerId;
  joystickBase.setPointerCapture(e.pointerId);
  updateMobileJoystick(e.clientX, e.clientY);
});
joystickBase.addEventListener('pointermove', (e) => {
  if (controlMode !== 'mobile' || joystickPointerId !== e.pointerId) return;
  updateMobileJoystick(e.clientX, e.clientY);
});
const releaseJoystick = (e: PointerEvent) => {
  if (joystickPointerId !== e.pointerId) return;
  joystickPointerId = null;
  mobileMoveX = 0; mobileMoveY = 0;
  joystickKnob.style.transform = 'translate(-50%, -50%)';
};
joystickBase.addEventListener('pointerup', releaseJoystick);
joystickBase.addEventListener('pointercancel', releaseJoystick);

mobileRunButton.addEventListener('pointerdown', () => { if (controlMode !== 'mobile') return; mobileRunPressed = true; mobileRunButton.style.opacity = '1'; });
const releaseRun = () => { mobileRunPressed = false; mobileRunButton.style.opacity = '0.85'; };
mobileRunButton.addEventListener('pointerup', releaseRun);
mobileRunButton.addEventListener('pointercancel', releaseRun);
mobileRunButton.addEventListener('pointerleave', releaseRun);

mobileJumpButton.addEventListener('pointerdown', () => { if (controlMode !== 'mobile') return; mobileJumpQueued = true; });
mobileFireButton.addEventListener('pointerdown', () => { if (controlMode !== 'mobile') return; attemptShoot(); });
mobileSpecButton.addEventListener('pointerdown', () => { if (controlMode !== 'mobile') return; attemptSpecialShoot(); });
mobileStunButton.addEventListener('pointerdown', () => { if (controlMode !== 'mobile') return; attemptNonLethalShoot(); });
mobileTypeButton.addEventListener('pointerdown', () => { if (controlMode !== 'mobile') return; enterTypingMode(); });

mobileAns[0].addEventListener('pointerdown', () => submitAnswerByIndex(0));
mobileAns[1].addEventListener('pointerdown', () => submitAnswerByIndex(1));
mobileAns[2].addEventListener('pointerdown', () => submitAnswerByIndex(2));

// ─── Word Quiz Logic ──────────────────────────────────────────────────────────
function pickNewWord() {
  const idx = Math.floor(Math.random() * wordList.length);
  currentWord = wordList[idx];

  // Pick 2 random wrong answers (different words)
  const wrongs: string[] = [];
  const used = new Set<number>([idx]);
  while (wrongs.length < 2) {
    const ri = Math.floor(Math.random() * wordList.length);
    if (used.has(ri)) continue;
    used.add(ri);
    wrongs.push(wordList[ri].korean);
  }

  // Shuffle correct into 3 choices
  const allChoices = [currentWord.korean, ...wrongs];
  for (let i = allChoices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allChoices[i], allChoices[j]] = [allChoices[j], allChoices[i]];
  }

  currentChoices = allChoices;
  correctChoiceIndex = allChoices.indexOf(currentWord.korean);

  updateWordUI();
}

function updateWordUI() {
  if (!currentWord) return;
  wordDisplay.textContent = currentWord.english;
  for (let i = 0; i < 3; i++) {
    const label = `${i + 1}. ${currentChoices[i]}`;
    choiceEls[i].textContent = label;
    choiceEls[i].style.color = '#e8eefc';
    choiceEls[i].style.background = 'rgba(0,0,0,0.55)';
  }
}

function submitAnswerByIndex(index: number) {
  if (!hasJoinedRoom || !currentWord) return;
  if (index === correctChoiceIndex) {
    // Correct
    basicBullets += 1;
    updateBulletDisplay();
    highlightChoice(index, true);
    setTimeout(() => pickNewWord(), 300);
    triggerAttackAnim();
  } else {
    // Wrong
    highlightChoice(index, false);
    handleWrongAnswer();
  }
}

function highlightChoice(index: number, correct: boolean) {
  choiceEls[index].style.background = correct ? 'rgba(50,180,80,0.55)' : 'rgba(180,40,40,0.55)';
  if (!correct) {
    choiceEls[correctChoiceIndex].style.background = 'rgba(50,180,80,0.25)';
  }
}

function handleWrongAnswer() {
  if (!currentWord) return;
  // Find nearest enemy
  let nearestId: string | null = null;
  let nearestDist = Infinity;
  for (const [id, remote] of remotePlayers.entries()) {
    if (!remote.mesh.visible) continue;
    const d = playerPosition.distanceTo(remote.mesh.position);
    if (d < nearestDist) { nearestDist = d; nearestId = id; }
  }

  if (nearestId && hasJoinedRoom) {
    socket.emit('wrongAnswer', {
      nearestEnemyId: nearestId,
      english: currentWord.english,
      korean: currentWord.korean,
    });
  }
}

// ─── Attack Logic ─────────────────────────────────────────────────────────────
function attemptShoot() {
  if (!hasJoinedRoom || basicShootCooldown > 0 || isFrozen) return;
  if (basicBullets <= 0) { flashCombatFeed('기본 총알 없음! 단어를 맞추세요'); return; }
  basicBullets -= 1;
  updateBulletDisplay();
  basicShootCooldown = 0.18;
  triggerAttackAnim();

  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  socket.emit('shoot', {
    origin: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
    attackType: 'basic',
  });
}

function attemptSpecialShoot() {
  if (!hasJoinedRoom || specialShootCooldown > 0 || isFrozen) return;
  if (specialBullets <= 0) { flashCombatFeed('특수 총알 없음! 타이핑(T)으로 획득'); return; }
  specialBullets -= 1;
  updateBulletDisplay();
  specialShootCooldown = 0.22;
  triggerAttackAnim();

  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  socket.emit('shoot', {
    origin: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
    attackType: 'special',
  });
}

function attemptNonLethalShoot() {
  if (!hasJoinedRoom || nonLethalShootCooldown > 0 || isFrozen) return;
  if (nonLethalBullets <= 0) { flashCombatFeed('스턴 총알 없음! 기본 공격을 빗나가면 획득'); return; }
  nonLethalBullets -= 1;
  updateBulletDisplay();
  nonLethalShootCooldown = 0.25;
  triggerAttackAnim();

  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  socket.emit('shoot', {
    origin: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    direction: { x: direction.x, y: direction.y, z: direction.z },
    attackType: 'nonlethal',
  });
}

function triggerAttackAnim() {
  attackAnimTime = 0.22;
}

// ─── Kill Effects ─────────────────────────────────────────────────────────────
function spawnKillEffect(pos: THREE.Vector3, type: 'circle' | 'triangle') {
  const char = type === 'circle' ? '○' : '△';
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = type === 'circle' ? '#ff4444' : '#ff8800';
  ctx.font = 'bold 96px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2, 2, 1);
  sprite.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
  scene.add(sprite);
  killEffects.push({ sprite, age: 0 });
}

function updateKillEffects(dt: number) {
  for (let i = killEffects.length - 1; i >= 0; i--) {
    const ef = killEffects[i];
    ef.age += dt;
    const t = ef.age / 1.5;
    const mat = ef.sprite.material as THREE.SpriteMaterial;
    mat.opacity = Math.max(0, 1 - t);
    ef.sprite.position.y += dt * 0.5;
    if (ef.age >= 1.5) {
      scene.remove(ef.sprite);
      if (mat.map) mat.map.dispose();
      mat.dispose();
      killEffects.splice(i, 1);
    }
  }
}

// ─── Enemy Mark Sprites ───────────────────────────────────────────────────────
function addEnemyMark(targetId: string, english: string, korean: string, expiresAt: number) {
  // Remove existing mark on this target if any
  const existing = enemyMarks.get(targetId);
  if (existing) { scene.remove(existing.sprite); }

  const sprite = createMarkSprite(english, korean, expiresAt);
  scene.add(sprite);
  enemyMarks.set(targetId, { targetId, english, korean, expiresAt, sprite, lastUpdate: 0 });
}

function createMarkSprite(english: string, korean: string, expiresAt: number): THREE.Sprite {
  const canvas = buildMarkCanvas(english, korean, expiresAt);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 2.8, 1);
  return sprite;
}

function buildMarkCanvas(english: string, korean: string, expiresAt: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 220; canvas.height = 280;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Red "/" slash
  ctx.fillStyle = '#ff3333';
  ctx.font = 'bold 120px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('/', 110, 10);

  // English word
  ctx.fillStyle = '#ffcccc';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(english, 110, 132);

  // Korean meaning
  ctx.fillStyle = '#ffaaaa';
  ctx.font = '16px system-ui, sans-serif';
  const maxKorean = korean.length > 22 ? korean.slice(0, 22) + '…' : korean;
  ctx.fillText(maxKorean, 110, 162);

  // Countdown
  const secsLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const mins = Math.floor(secsLeft / 60);
  const secs = secsLeft % 60;
  const timerStr = `${mins}:${String(secs).padStart(2, '0')}`;
  ctx.fillStyle = '#ffdd88';
  ctx.font = 'bold 20px monospace';
  ctx.fillText(timerStr, 110, 192);

  return canvas;
}

function updateEnemyMarks(now: number) {
  for (const [id, mark] of enemyMarks.entries()) {
    if (now >= mark.expiresAt) {
      scene.remove(mark.sprite);
      const mat = mark.sprite.material as THREE.SpriteMaterial;
      if (mat.map) mat.map.dispose();
      mat.dispose();
      enemyMarks.delete(id);
      continue;
    }

    // Reposition above enemy mesh
    const remote = remotePlayers.get(id);
    if (remote && remote.mesh.visible) {
      mark.sprite.visible = true;
      mark.sprite.position.set(
        remote.mesh.position.x,
        remote.mesh.position.y + 3.2,
        remote.mesh.position.z
      );
    } else {
      mark.sprite.visible = false;
    }

    // Update timer canvas once per second
    if (now - mark.lastUpdate >= 1000) {
      mark.lastUpdate = now;
      const mat = mark.sprite.material as THREE.SpriteMaterial;
      if (mat.map) mat.map.dispose();
      const canvas = buildMarkCanvas(mark.english, mark.korean, mark.expiresAt);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.needsUpdate = true;
    }
  }
}

// ─── Animate Loop ─────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.033);
  const now = performance.now();

  // Cooldowns
  basicShootCooldown = Math.max(0, basicShootCooldown - dt);
  specialShootCooldown = Math.max(0, specialShootCooldown - dt);
  nonLethalShootCooldown = Math.max(0, nonLethalShootCooldown - dt);

  // Freeze
  if (isFrozen && now >= frozenUntil) isFrozen = false;

  // Movement (blocked when frozen or typing)
  if (!isFrozen && !isTypingMode) {
    const keyFwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const keyRight = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const moveForward = controlMode === 'mobile' ? mobileMoveY : keyFwd;
    const moveRight = controlMode === 'mobile' ? mobileMoveX : keyRight;
    const isRunning = controlMode === 'mobile' ? mobileRunPressed : keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = isRunning ? runSpeed : walkSpeed;

    const inputVec = new THREE.Vector2(moveRight, moveForward);
    if (inputVec.lengthSq() > 1) inputVec.normalize();

    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    playerPosition.addScaledVector(forward, inputVec.y * speed * dt);
    playerPosition.addScaledVector(right, inputVec.x * speed * dt);

    const jumpPressed = controlMode === 'mobile' ? mobileJumpQueued : keys.has('Space');
    if (jumpPressed && canJump) { velocityY = jumpSpeed; canJump = false; }
    mobileJumpQueued = false;
  }

  velocityY -= gravity * dt;
  playerPosition.y += velocityY * dt;
  if (playerPosition.y <= 1.7) { playerPosition.y = 1.7; velocityY = 0; canJump = true; }

  camera.position.copy(playerPosition);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.rotation.z = 0;

  // Book attack animation
  if (attackAnimTime > 0) {
    attackAnimTime -= dt;
    const t = Math.max(0, attackAnimTime) / 0.22;
    const swing = Math.sin((1 - t) * Math.PI);
    bookGroup.position.set(
      bookRestPos.x + swing * 0.05,
      bookRestPos.y - swing * 0.06,
      bookRestPos.z - swing * 0.08
    );
    bookGroup.rotation.x = bookRestRot.x + swing * 0.35;
  } else {
    bookGroup.position.copy(bookRestPos);
    bookGroup.rotation.set(bookRestRot.x, bookRestRot.y, bookRestRot.z);
  }

  // Send player state
  sendAccumulator += dt;
  if (socket.connected && hasJoinedRoom && sendAccumulator >= 0.05) {
    sendAccumulator = 0;
    socket.emit('playerUpdate', { position: { x: playerPosition.x, y: playerPosition.y, z: playerPosition.z }, yaw });
  }

  // Interpolate remote players
  for (const remote of remotePlayers.values()) {
    if (!remote.mesh.visible) { remote.labelSprite.visible = false; continue; }
    remote.mesh.position.lerp(remote.targetPosition, 1 - Math.exp(-14 * dt));
    remote.mesh.rotation.y += (remote.targetYaw - remote.mesh.rotation.y) * (1 - Math.exp(-14 * dt));
    remote.labelSprite.position.set(remote.mesh.position.x, remote.mesh.position.y + 1.6, remote.mesh.position.z);
    remote.labelSprite.lookAt(camera.position);
  }

  updateKillEffects(dt);
  updateEnemyMarks(Date.now());

  renderer.render(scene, camera);
}

animate();

// ─── Setup UI Handlers ────────────────────────────────────────────────────────
joinButton.addEventListener('click', () => {
  joinError.style.color = '#ff9b9b';
  joinError.textContent = '';
  const nickname = nicknameInput.value.trim().slice(0, 16);
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  roomCodeInput.value = roomCode;
  if (!nickname) { joinError.textContent = 'Please enter a nickname.'; return; }
  if (!roomCode) { joinError.textContent = 'Please enter a room code.'; return; }
  localNickname = nickname;
  localHp = 100; localKills = 0; localDeaths = 0;
  basicBullets = 0; specialBullets = 0; nonLethalBullets = 0;
  updateCombatStatus(); updateBulletDisplay();
  if (socket.connected) {
    socket.emit('joinRoom', { nickname, roomCode });
  } else {
    socket.connect();
    socket.once('connect', () => socket.emit('joinRoom', { nickname, roomCode }));
  }
});

randomRoomButton.addEventListener('click', () => { roomCodeInput.value = makeRoomCode(); joinError.textContent = ''; });

copyRoomButton.addEventListener('click', async () => {
  const roomCode = normalizeRoomCode(roomCodeInput.value);
  roomCodeInput.value = roomCode;
  if (!roomCode) { joinError.textContent = 'Enter room code first.'; return; }
  try {
    await navigator.clipboard.writeText(roomCode);
    joinError.style.color = '#9dffbc';
    joinError.textContent = 'Room code copied.';
  } catch {
    joinError.style.color = '#ff9b9b';
    joinError.textContent = 'Clipboard blocked.';
  }
});

roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinButton.click(); });
nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinButton.click(); });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ─── Helpers / Utilities ──────────────────────────────────────────────────────
function syncRemotePlayers(players: NetPlayer[]) {
  const presentIds = new Set<string>();
  for (const player of players) {
    if (!player || player.id === localPlayerId) continue;
    presentIds.add(player.id);

    let remote = remotePlayers.get(player.id);
    if (!remote) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 2, 1),
        new THREE.MeshStandardMaterial({ map: remoteTexture, color: 0xfff1e8, roughness: 0.5, metalness: 0.03 })
      );
      mesh.position.set(player.position.x, Math.max(1, player.position.y - 0.7), player.position.z);
      mesh.castShadow = true;
      const labelSprite = createNameTag(player.nickname);
      labelSprite.position.set(mesh.position.x, mesh.position.y + 1.6, mesh.position.z);
      scene.add(mesh);
      scene.add(labelSprite);
      remote = { mesh, targetPosition: mesh.position.clone(), targetYaw: player.yaw, labelSprite, labelText: player.nickname };
      remotePlayers.set(player.id, remote);
    }
    if (remote.labelText !== player.nickname) { updateNameTag(remote.labelSprite, player.nickname); remote.labelText = player.nickname; }
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
    if (remote.mesh.material instanceof THREE.Material) remote.mesh.material.dispose();
    const sm = remote.labelSprite.material;
    if (sm instanceof THREE.SpriteMaterial && sm.map) sm.map.dispose();
    if (sm instanceof THREE.Material) sm.dispose();
    remotePlayers.delete(id);
  }
}

function setRoomStatus(roomCode: string, count: number) {
  if (!roomCode) return;
  roomStatus.textContent = `Room: ${roomCode} | Players: ${count}`;
}

function syncLocalCombatStats(players: NetPlayer[]) {
  const me = players.find((p) => p.id === localPlayerId);
  if (!me) return;
  localHp = me.hp; localKills = me.kills; localDeaths = me.deaths;
  updateCombatStatus();
}

function updateCombatStatus() {
  combatStatus.textContent = `HP: ${Math.max(0, Math.floor(localHp))} | K:${localKills} D:${localDeaths}`;
}

function updateBulletDisplay() {
  bulletStatus.textContent = `기본: ${basicBullets}  특수: ${specialBullets}  스턴: ${nonLethalBullets}`;
}

let combatFeedTimer: number | null = null;
function flashCombatFeed(msg: string) {
  combatFeed.textContent = msg;
  combatFeed.style.opacity = '1';
  if (combatFeedTimer !== null) window.clearTimeout(combatFeedTimer);
  combatFeedTimer = window.setTimeout(() => { combatFeed.style.opacity = '0'; }, 1600);
}

function setControlMode(mode: ControlMode) {
  controlMode = mode;
  const isMobile = mode === 'mobile';
  mobileHud.style.display = isMobile ? 'block' : 'none';
  info.textContent = isMobile
    ? 'Mobile mode (left joystick move, right side drag look)'
    : 'Click to play (WASD move, Shift run, Space jump, Mouse look)';
  info.style.display = isMobile ? 'block' : (document.pointerLockElement === renderer.domElement ? 'none' : 'block');
  crosshair.style.opacity = (isMobile || document.pointerLockElement === renderer.domElement) ? '0.9' : '0';
  if (isMobile && document.pointerLockElement === renderer.domElement) document.exitPointerLock();
  pcModeButton.style.background = mode === 'pc' ? '#41c1ff' : 'rgba(255,255,255,0.08)';
  pcModeButton.style.color = mode === 'pc' ? '#031523' : '#e8eefc';
  mobileModeButton.style.background = mode === 'mobile' ? '#41c1ff' : 'rgba(255,255,255,0.08)';
  mobileModeButton.style.color = mode === 'mobile' ? '#031523' : '#e8eefc';
}

function updateMobileJoystick(clientX: number, clientY: number) {
  const rect = joystickBase.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const dx = clientX - cx, dy = clientY - cy;
  const radius = rect.width * 0.36;
  const distance = Math.hypot(dx, dy);
  const clamp = distance > radius ? radius / distance : 1;
  mobileMoveX = (dx * clamp) / radius;
  mobileMoveY = -(dy * clamp) / radius;
  joystickKnob.style.transform = `translate(calc(-50% + ${mobileMoveX * radius}px), calc(-50% + ${-mobileMoveY * radius}px))`;
}

function createNameTag(name: string): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ map: createNameTagTexture(name), transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.8, 0.5, 1);
  return sprite;
}

function updateNameTag(sprite: THREE.Sprite, name: string) {
  const mat = sprite.material;
  if (!(mat instanceof THREE.SpriteMaterial)) return;
  if (mat.map) mat.map.dispose();
  mat.map = createNameTagTexture(name);
  mat.needsUpdate = true;
}

function createNameTagTexture(name: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 72;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(7,12,26,0.72)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 16), canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function applyInputStyle(input: HTMLInputElement) {
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.05);color:#e8eefc;outline:none;font-family:system-ui,sans-serif;';
}

function applyMiniButtonStyle(button: HTMLButtonElement) {
  button.style.cssText = 'flex:1;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.08);color:#e8eefc;font-weight:600;cursor:pointer;font-family:system-ui,sans-serif;';
}

function createActionButton(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText = 'padding:8px 4px;border-radius:10px;border:1px solid rgba(255,255,255,0.22);background:rgba(12,18,34,0.72);color:#e8eefc;font-weight:700;cursor:pointer;opacity:0.85;touch-action:none;font-family:system-ui,sans-serif;font-size:13px;';
  return btn;
}

function createCheckerTexture(): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const size = 16;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    ctx.fillStyle = (x + y) % 2 === 0 ? '#ff8f5a' : '#ffd8be';
    ctx.fillRect(x * size, y * size, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function normalizeRoomCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function makeRoomCode(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += a[Math.floor(Math.random() * a.length)];
  return code;
}
