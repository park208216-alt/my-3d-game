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
};
const remotePlayers = new Map<string, RemotePlayer>();
let sendAccumulator = 0;

const socketUrl =
  (import.meta.env.VITE_SOCKET_URL as string | undefined) ??
  window.location.origin;
const socket = io(socketUrl, {
  path: '/socket.io',
  transports: ['websocket'],
});

socket.on('connect', () => {
  localPlayerId = socket.id ?? localPlayerId;
  netStatus.textContent = 'Multiplayer connected';
});

socket.on('disconnect', () => {
  netStatus.textContent = 'Disconnected from server';
});

type NetPlayer = {
  id: string;
  position: { x: number; y: number; z: number };
  yaw: number;
};

socket.on('bootstrap', (payload: { id: string; players: NetPlayer[] }) => {
  localPlayerId = payload.id;
  netStatus.textContent = `Multiplayer connected (${payload.players.length} players)`;
  upsertRemotePlayers(payload.players);
});

socket.on('playerJoined', (player: NetPlayer) => {
  upsertRemotePlayers([player]);
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
  upsertRemotePlayers(players);
});

renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  info.style.display = locked ? 'none' : 'block';
});

document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== renderer.domElement) return;

  yaw -= event.movementX * lookSensitivity;
  pitch -= event.movementY * lookSensitivity;
  pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.033);

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
  if (socket.connected && sendAccumulator >= 0.05) {
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
    remote.mesh.position.lerp(remote.targetPosition, 1 - Math.exp(-14 * dt));
    remote.mesh.rotation.y += (remote.targetYaw - remote.mesh.rotation.y) * (1 - Math.exp(-14 * dt));
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

function upsertRemotePlayers(players: NetPlayer[]) {
  for (const player of players) {
    if (!player || player.id === localPlayerId) continue;

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
      scene.add(mesh);
      remote = {
        mesh,
        targetPosition: mesh.position.clone(),
        targetYaw: player.yaw,
      };
      remotePlayers.set(player.id, remote);
    }

    remote.targetPosition.set(player.position.x, Math.max(1, player.position.y - 0.7), player.position.z);
    remote.targetYaw = player.yaw;
  }
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