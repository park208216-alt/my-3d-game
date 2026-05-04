import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { io } from 'socket.io-client';
import { wordList } from './words';
import { ANIMALS, ANIMAL_IDS, BASE_HP, BASE_HP_1P_ENEMY, FIELD_LEN, SPAWN_P1, SPAWN_P2, AIR_Y, MOLE_SURFACE_DETECT } from './animals';
import type { AnimalDef } from './animals';

// ─── Model Loading ────────────────────────────────────────────────────────────
const MODEL_MAP: Record<string, string> = {
  lion:     'animal-lion',
  elephant: 'animal-elephant',
  mouse:    'animal-bunny',
  eagle:    'animal-parrot',
  monkey:   'animal-monkey',
  mole:     'animal-beaver',
};

const modelTemplates: Record<string, THREE.Group> = {};
let modelsReady = false;
let modelsLoadPromise: Promise<void> | null = null;

function loadAllModels(): Promise<void> {
  if (modelsLoadPromise) return modelsLoadPromise;
  const loader = new GLTFLoader();
  const base = '/assets/animals/';
  modelsLoadPromise = Promise.all(
    Object.entries(MODEL_MAP).map(([id, name]) =>
      new Promise<void>((resolve) => {
        loader.load(
          `${base}${name}.glb`,
          (gltf) => {
            const root = gltf.scene;
            root.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh) {
                const mesh = obj as THREE.Mesh;
                mesh.castShadow = true;
                const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                mats.forEach(m => { (m as THREE.MeshStandardMaterial).side = THREE.FrontSide; });
              }
            });
            modelTemplates[id] = root;
            resolve();
          },
          undefined,
          (err) => {
            console.warn(`Failed to load ${name}.glb:`, err);
            resolve(); // 실패해도 게임은 시작 (폴백 박스 사용)
          }
        );
      })
    )
  ).then(() => { modelsReady = true; });
  return modelsLoadPromise;
}

// 페이지 로드와 동시에 백그라운드에서 모델 로딩 시작
loadAllModels();

// ─── Constants ────────────────────────────────────────────────────────────────
const CURRENCY_MAX = 15;
const CURRENCY_AUTO_INTERVAL = 2; // seconds
const CURRENCY_MC = 1;   // multiple-choice correct
const CURRENCY_TYPE = 3; // typing correct
const ROUND_DURATION = 30; // seconds per round

// 1P AI spawn tables per round [animalId, weight]
const AI_ROUNDS: Array<{ interval: number; pool: string[] }> = [
  { interval: 5.0, pool: ['mouse','mouse','mouse','mole'] },
  { interval: 4.0, pool: ['mouse','mole','lion'] },
  { interval: 3.5, pool: ['mouse','lion','eagle','monkey'] },
  { interval: 3.0, pool: ['lion','elephant','eagle','monkey'] },
  { interval: 2.5, pool: ['lion','elephant','eagle','monkey','mouse','mole'] },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type GameMode = '1p' | '2p';
type Screen = 'menu' | 'deck' | 'lobby2p' | 'battle' | 'result';
type Side = 'p1' | 'p2';
type UnitState = 'moving' | 'attacking' | 'underground' | 'dead';

interface UnitSim {
  id: string;
  animalId: string;
  side: Side;
  z: number;
  x: number;
  hp: number;
  maxHp: number;
  state: UnitState;
  atkTimer: number;
  mesh: THREE.Object3D | null;
  hpSprite: THREE.Sprite | null;
  dustMesh: THREE.Mesh | null; // mole indicator
  lastHp: number;
}

interface BaseSim {
  hp: number;
  maxHp: number;
  z: number;
  mesh: THREE.Mesh;
  hpSprite: THREE.Sprite;
  lastHp: number;
}

// ─── Three.js Setup (top half of screen) ─────────────────────────────────────
const CANVAS_H = () => Math.floor(window.innerHeight * 0.5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.domElement.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:50vh;z-index:0;';
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#0b1020';
document.body.appendChild(renderer.domElement);

function resizeRenderer() {
  const w = window.innerWidth, h = CANVAS_H();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2540);
scene.fog = new THREE.Fog(0x1a2540, 50, 80);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / CANVAS_H(), 0.1, 200);
resizeRenderer();
window.addEventListener('resize', resizeRenderer);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xfff5e0, 1.0);
sun.position.set(5, 12, -5);
scene.add(sun);

// ─── Camera Pan ───────────────────────────────────────────────────────────────
let camPan = 0; // Z-axis offset for side-view panning
let camPanStartX = 0;
let camPanActive = false;

renderer.domElement.addEventListener('pointerdown', (e) => {
  camPanActive = true;
  camPanStartX = e.clientX;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!camPanActive) return;
  const dx = e.clientX - camPanStartX;
  camPanStartX = e.clientX;
  // drag right → see more toward p1 base (lower Z); invert for p2
  const dir = localSide === 'p2' ? 1 : -1;
  camPan = Math.max(-18, Math.min(18, camPan + dir * dx * 0.04));
});
renderer.domElement.addEventListener('pointerup', () => { camPanActive = false; });
renderer.domElement.addEventListener('pointercancel', () => { camPanActive = false; });

// ─── Field Geometry ───────────────────────────────────────────────────────────
function buildField() {
  // Ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(12, FIELD_LEN + 4),
    new THREE.MeshStandardMaterial({ color: 0x3a5c3a, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.01, FIELD_LEN / 2);
  scene.add(ground);

  // Center lane
  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, FIELD_LEN),
    new THREE.MeshStandardMaterial({ color: 0x4a7040, roughness: 1 })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, 0, FIELD_LEN / 2);
  scene.add(lane);

  // Grid lines
  const grid = new THREE.GridHelper(FIELD_LEN + 4, 12, 0x2a4a2a, 0x2a4a2a);
  grid.position.set(0, 0.01, FIELD_LEN / 2);
  scene.add(grid);
}
buildField();

// ─── Base Factory ─────────────────────────────────────────────────────────────
function makeBase(z: number, color: number, hp: number): BaseSim {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(3, 3, 1.5),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4 })
  );
  mesh.position.set(0, 1.5, z);
  scene.add(mesh);

  const hpSprite = makeHpSprite(hp, hp);
  hpSprite.position.set(0, 3.8, z);
  scene.add(hpSprite);

  return { hp, maxHp: hp, z, mesh, hpSprite, lastHp: hp };
}

// ─── HP Sprite ────────────────────────────────────────────────────────────────
function makeHpSprite(hp: number, maxHp: number): THREE.Sprite {
  const canvas = drawHpCanvas(hp, maxHp);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.0, 0.45, 1);
  return sprite;
}

function drawHpCanvas(hp: number, maxHp: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 24;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 128, 24);
  const frac = Math.max(0, hp / maxHp);
  const r = Math.round(255 * (1 - frac));
  const g = Math.round(255 * frac);
  ctx.fillStyle = `rgb(${r},${g},0)`;
  ctx.fillRect(2, 2, Math.round(124 * frac), 20);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.ceil(hp)}`, 64, 12);
  return c;
}

function refreshHpSprite(sprite: THREE.Sprite, hp: number, maxHp: number) {
  const mat = sprite.material as THREE.SpriteMaterial;
  if (mat.map) mat.map.dispose();
  const canvas = drawHpCanvas(hp, maxHp);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  mat.map = tex;
  mat.needsUpdate = true;
}

// ─── Unit Mesh Factory ────────────────────────────────────────────────────────
// Scale factors per animal so they look right at game-unit sizes
const MODEL_SCALE: Record<string, number> = {
  lion: 0.9, elephant: 1.2, mouse: 0.55, eagle: 0.7, monkey: 0.75, mole: 0.6,
};

function makeUnitMesh(def: AnimalDef, side: Side): THREE.Object3D {
  const template = modelTemplates[def.id];
  if (!template) {
    // Fallback box if model not loaded yet
    return new THREE.Mesh(
      new THREE.BoxGeometry(def.size * 2, def.size * 2, def.size * 2),
      new THREE.MeshStandardMaterial({ color: def.color })
    );
  }

  const model = template.clone(true);
  const s = MODEL_SCALE[def.id] ?? def.size;
  model.scale.set(s, s, s);

  // p2 faces the opposite direction (toward p1 base)
  if (side === 'p2') model.rotation.y = Math.PI;

  // Tint p2 units with a slight blue overlay so they're visually distinct
  if (side === 'p2') {
    model.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = mats.map((m) => {
          const c = (m as THREE.MeshStandardMaterial).clone();
          c.color.multiplyScalar(0.7);
          c.color.b = Math.min(1, c.color.b + 0.4);
          return c;
        });
      }
    });
  }

  return model;
}

function makeDustMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8),
    new THREE.MeshStandardMaterial({ color: 0x7a5c40, transparent: true, opacity: 0.7 })
  );
  return mesh;
}

// ─── Unit Simulation ──────────────────────────────────────────────────────────
let units: UnitSim[] = [];
let p1Base!: BaseSim;
let p2Base!: BaseSim;
let unitIdCounter = 0;

function spawnUnit(animalId: string, side: Side): UnitSim {
  const def = ANIMALS[animalId];
  const id = `u${++unitIdCounter}`;
  const z = side === 'p1' ? SPAWN_P1 : SPAWN_P2;
  const x = (Math.random() - 0.5) * 5;

  const mesh = makeUnitMesh(def, side);
  const yPos = def.layer === 'air' ? AIR_Y : def.size;
  mesh.position.set(x, yPos, z);
  if (def.layer === 'underground') mesh.visible = false;
  scene.add(mesh);

  const hpSprite = makeHpSprite(def.hp, def.hp);
  hpSprite.position.set(x, yPos + def.size + 0.6, z);
  if (def.layer === 'underground') hpSprite.visible = false;
  scene.add(hpSprite);

  let dustMesh: THREE.Mesh | null = null;
  if (def.layer === 'underground') {
    dustMesh = makeDustMesh();
    dustMesh.position.set(x, 0.05, z);
    scene.add(dustMesh);
  }

  const unit: UnitSim = {
    id, animalId, side, z, x,
    hp: def.hp, maxHp: def.hp,
    state: def.layer === 'underground' ? 'underground' : 'moving',
    atkTimer: 0,
    mesh, hpSprite, dustMesh,
    lastHp: def.hp,
  };
  units.push(unit);
  return unit;
}

function removeUnitMeshes(unit: UnitSim) {
  if (unit.mesh) {
    scene.remove(unit.mesh);
    unit.mesh.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        mats.forEach(mat => (mat as THREE.Material).dispose());
      }
    });
    unit.mesh = null;
  }
  if (unit.hpSprite) { scene.remove(unit.hpSprite); const m = unit.hpSprite.material as THREE.SpriteMaterial; if (m.map) m.map.dispose(); m.dispose(); unit.hpSprite = null; }
  if (unit.dustMesh) { scene.remove(unit.dustMesh); unit.dustMesh.geometry.dispose(); (unit.dustMesh.material as THREE.Material).dispose(); unit.dustMesh = null; }
}

// ─── Unit AI ──────────────────────────────────────────────────────────────────
function stepUnits(dt: number) {
  const alive = units.filter(u => u.state !== 'dead');

  for (const u of alive) {
    u.atkTimer = Math.max(0, u.atkTimer - dt);
    const def = ANIMALS[u.animalId];
    const dir = u.side === 'p1' ? 1 : -1;
    const targetBase = u.side === 'p1' ? p2Base : p1Base;
    const enemies = alive.filter(e => e.side !== u.side && e.state !== 'underground');

    if (def.layer === 'underground') {
      stepMole(u, dt, dir, enemies, targetBase);
    } else {
      stepGroundOrAir(u, dt, dir, def, enemies, targetBase);
    }
  }
}

function canAttackEnemy(def: AnimalDef, enemyDef: AnimalDef): boolean {
  if (def.attackLayer === 'ground' && enemyDef.layer === 'air') return false;
  return true;
}

function stepGroundOrAir(u: UnitSim, dt: number, dir: number, def: AnimalDef, enemies: UnitSim[], base: BaseSim) {
  const attackable = enemies.filter(e => canAttackEnemy(def, ANIMALS[e.animalId]));

  // Find closest enemy in range
  let closest: UnitSim | null = null;
  let closestDist = Infinity;
  for (const e of attackable) {
    const d = Math.abs(e.z - u.z);
    if (d < closestDist) { closestDist = d; closest = e; }
  }

  const baseDist = Math.abs(base.z - u.z);

  if (def.ranged) {
    // Monkey: attack from range, never advance closer than range
    if (closest && closestDist <= def.range) {
      // Attack
      u.state = 'attacking';
      if (u.atkTimer <= 0) {
        closest.hp = Math.max(0, closest.hp - def.atk);
        u.atkTimer = def.atkCooldown;
        if (closest.hp <= 0) closest.state = 'dead';
      }
      return;
    }
    if (baseDist <= def.range) {
      u.state = 'attacking';
      if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - def.atk); u.atkTimer = def.atkCooldown; }
      return;
    }
    // Advance
    u.state = 'moving';
    u.z += dir * def.spd * dt;
    return;
  }

  // Melee
  if (closest && closestDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) {
      closest.hp = Math.max(0, closest.hp - def.atk);
      u.atkTimer = def.atkCooldown;
      if (closest.hp <= 0) closest.state = 'dead';
    }
    return;
  }
  if (baseDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - def.atk); u.atkTimer = def.atkCooldown; }
    return;
  }
  u.state = 'moving';
  u.z += dir * def.spd * dt;
}

function stepMole(u: UnitSim, dt: number, dir: number, enemies: UnitSim[], base: BaseSim) {
  const def = ANIMALS['mole'];
  const groundEnemies = enemies.filter(e => ANIMALS[e.animalId].layer !== 'air');
  const baseDist = Math.abs(base.z - u.z);

  if (u.state === 'underground') {
    // Check for nearby ground enemies or base
    const nearEnemy = groundEnemies.find(e => Math.abs(e.z - u.z) <= MOLE_SURFACE_DETECT);
    if (nearEnemy || baseDist <= def.range) {
      u.state = 'moving'; // surface
      return;
    }
    u.z += dir * def.spd * dt;
    return;
  }

  // Surfaced - act like melee ground unit
  const nearest = groundEnemies.reduce<UnitSim | null>((best, e) => {
    const d = Math.abs(e.z - u.z);
    return !best || d < Math.abs(best.z - u.z) ? e : best;
  }, null);

  if (nearest && Math.abs(nearest.z - u.z) <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) {
      nearest.hp = Math.max(0, nearest.hp - def.atk);
      u.atkTimer = def.atkCooldown;
      if (nearest.hp <= 0) nearest.state = 'dead';
    }
    return;
  }
  if (baseDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - def.atk); u.atkTimer = def.atkCooldown; }
    return;
  }
  // No targets nearby - go back underground
  u.state = 'underground';
}

// ─── Three.js Unit Sync (after simulation step) ───────────────────────────────
function syncUnitMeshes() {
  const toRemove: UnitSim[] = [];

  for (const u of units) {
    if (u.state === 'dead') {
      toRemove.push(u);
      continue;
    }
    const def = ANIMALS[u.animalId];
    const underground = u.state === 'underground' && def.layer === 'underground';
    const airY = def.layer === 'air' ? AIR_Y : def.size;
    const yPos = underground ? -5 : airY;

    if (u.mesh) {
      u.mesh.position.set(u.x, yPos, u.z);
      u.mesh.visible = !underground;
    }
    if (u.hpSprite) {
      u.hpSprite.position.set(u.x, yPos + def.size + 0.6, u.z);
      u.hpSprite.visible = !underground;
      if (u.hp !== u.lastHp) {
        refreshHpSprite(u.hpSprite, u.hp, u.maxHp);
        u.lastHp = u.hp;
      }
    }
    if (u.dustMesh) {
      u.dustMesh.position.set(u.x, 0.05, u.z);
      u.dustMesh.visible = underground;
    }
  }

  for (const u of toRemove) {
    removeUnitMeshes(u);
    units = units.filter(x => x.id !== u.id);
  }
}

function syncBaseMeshes() {
  for (const base of [p1Base, p2Base]) {
    if (base.hp !== base.lastHp) {
      refreshHpSprite(base.hpSprite, base.hp, base.maxHp);
      base.lastHp = base.hp;
    }
  }
}

// ─── Game State ───────────────────────────────────────────────────────────────
let gameMode: GameMode = '1p';
let currentScreen: Screen = 'menu';
let battleActive = false;

let currency = 0;
let autoCurrencyTimer = 0;
let stateSyncTimer = 0;
let round = 1;
let roundTimer = 0;
let aiSpawnTimer = 0;

let currentWord = wordList[0];
let currentChoices: string[] = [];
let correctIdx = 0;
let isTypingMode = false;

// 2P socket state
const socketUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? window.location.origin;
const socket = io(socketUrl, { path: '/socket.io', transports: ['websocket'], autoConnect: false });
let localSide: Side = 'p1';

// ─── HTML Screens ─────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;

document.body.insertAdjacentHTML('beforeend', `
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;color:#e8eefc;}
  .screen{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(8,14,30,0.96);z-index:50;}
  .screen.hidden{display:none;}
  .btn{padding:12px 28px;border-radius:12px;border:1px solid rgba(255,255,255,0.25);background:#2a4080;color:#e8eefc;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.15s;}
  .btn:hover{background:#3a55aa;}
  .btn.primary{background:#41c1ff;color:#031523;}
  .btn.primary:hover{background:#60d0ff;}
  .btn.danger{background:#c03030;}
  h1{font-size:2.4em;margin:0 0 32px;letter-spacing:2px;}
  h2{font-size:1.6em;margin:0 0 20px;}
  input.field{padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.07);color:#e8eefc;font-size:15px;outline:none;width:240px;}
  .gap{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;}
  .animal-card{padding:12px 16px;border-radius:12px;border:2px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);min-width:110px;text-align:center;font-size:13px;cursor:default;}
  .animal-card .aname{font-size:15px;font-weight:700;margin-bottom:6px;}
  .animal-card .astat{opacity:0.75;line-height:1.6;}
</style>

<!-- MENU -->
<div id="screen-menu" class="screen">
  <h1>Zoo Battle</h1>
  <div class="gap">
    <button class="btn primary" id="btn-1p">1인용</button>
    <button class="btn" id="btn-2p">2인용 (온라인)</button>
  </div>
</div>

<!-- DECK -->
<div id="screen-deck" class="screen hidden">
  <h2>전투 덱 (6마리 모두 출전)</h2>
  <div class="gap" id="deck-cards"></div>
  <div style="margin-top:24px;" class="gap">
    <button class="btn" id="btn-deck-back">← 뒤로</button>
    <button class="btn primary" id="btn-deck-start">전투 시작 →</button>
  </div>
</div>

<!-- 2P LOBBY -->
<div id="screen-lobby2p" class="screen hidden">
  <h2>2인 대전 로비</h2>
  <input class="field" id="in-nick" placeholder="닉네임" style="margin-bottom:10px;">
  <input class="field" id="in-room" placeholder="방 코드 (예: BATTLE1)" style="margin-bottom:10px;">
  <div class="gap" style="margin-bottom:10px;">
    <button class="btn" id="btn-rndroom">랜덤 코드</button>
    <button class="btn primary" id="btn-joinroom">참가</button>
  </div>
  <div id="lobby-status" style="font-size:13px;opacity:0.8;min-height:20px;"></div>
  <button class="btn" id="btn-lobby-back" style="margin-top:16px;">← 뒤로</button>
</div>

<!-- RESULT -->
<div id="screen-result" class="screen hidden">
  <h2 id="result-text">결과</h2>
  <button class="btn primary" id="btn-result-menu">메인 메뉴로</button>
</div>

<!-- BATTLE PANEL (bottom 50%) -->
<div id="panel-battle" style="position:fixed;bottom:0;left:0;right:0;height:50vh;display:none;z-index:10;background:rgba(8,14,30,0.92);border-top:2px solid rgba(255,255,255,0.12);">
  <!-- HUD top bar -->
  <div id="battle-hud" style="position:absolute;top:0;left:0;right:0;height:32px;background:rgba(0,0,0,0.4);display:flex;align-items:center;padding:0 12px;gap:16px;font-size:13px;">
    <span id="hud-currency">재화: 0 / 10</span>
    <span id="hud-round" style="color:#adf;"></span>
    <span id="hud-timer" style="color:#fda;"></span>
    <span id="hud-base" style="color:#fca;margin-left:auto;"></span>
  </div>
  <!-- Left: summon buttons -->
  <div id="panel-left" style="position:absolute;top:32px;left:0;width:50%;bottom:0;display:flex;flex-direction:column;padding:8px;gap:6px;">
    <div id="summon-grid" style="display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(2,1fr);gap:6px;flex:1;"></div>
  </div>
  <!-- Right: word quiz -->
  <div id="panel-right" style="position:absolute;top:32px;right:0;width:50%;bottom:0;display:flex;flex-direction:column;padding:8px;gap:6px;overflow:hidden;">
    <div id="word-en" style="text-align:center;font-size:20px;font-weight:700;color:#fff;padding:4px;background:rgba(255,255,255,0.07);border-radius:8px;"></div>
    <div id="choices" style="display:flex;flex-direction:column;gap:4px;flex:1;"></div>
    <div id="typing-row" style="display:flex;gap:6px;">
      <button id="btn-type" style="padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,200,80,0.15);color:#ffe08a;font-weight:700;cursor:pointer;font-size:13px;white-space:nowrap;">T 타이핑</button>
      <input id="type-input" placeholder="한글 뜻 입력 후 Enter" style="display:none;flex:1;padding:6px 10px;border-radius:8px;border:1px solid rgba(120,200,255,0.6);background:rgba(10,20,40,0.8);color:#fff;font-size:13px;outline:none;">
    </div>
    <div id="quiz-msg" style="font-size:12px;color:#ff9b9b;min-height:16px;text-align:center;"></div>
  </div>
</div>
`);

// ─── Loading Overlay ──────────────────────────────────────────────────────────
document.body.insertAdjacentHTML('beforeend', `
<div id="loading-overlay" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(8,14,30,0.96);align-items:center;justify-content:center;flex-direction:column;gap:16px;">
  <div style="width:48px;height:48px;border:5px solid rgba(255,255,255,0.15);border-top-color:#41c1ff;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
  <div style="color:#a0c8ff;font-size:14px;">모델 로딩 중...</div>
</div>
<style>@keyframes spin{to{transform:rotate(360deg);}}</style>
`);
function showLoadingOverlay(show: boolean) {
  ($('loading-overlay') as HTMLElement).style.display = show ? 'flex' : 'none';
}

// ─── Screen Manager ───────────────────────────────────────────────────────────
function showScreen(s: Screen) {
  currentScreen = s;
  $('screen-menu').classList.toggle('hidden', s !== 'menu');
  $('screen-deck').classList.toggle('hidden', s !== 'deck');
  $('screen-lobby2p').classList.toggle('hidden', s !== 'lobby2p');
  $('screen-result').classList.toggle('hidden', s !== 'result');
  $('panel-battle').style.display = s === 'battle' ? 'block' : 'none';
  renderer.domElement.style.display = s === 'battle' ? 'block' : 'none';
}
showScreen('menu');
renderer.domElement.style.display = 'none';

// ─── Deck Screen ──────────────────────────────────────────────────────────────
function buildDeckCards() {
  const container = $('deck-cards');
  container.innerHTML = '';
  for (const id of ANIMAL_IDS) {
    const d = ANIMALS[id];
    const card = document.createElement('div');
    card.className = 'animal-card';
    card.innerHTML = `
      <div class="aname" style="color:#${d.color.toString(16).padStart(6,'0')}">${d.name}</div>
      <div class="astat">
        HP ${d.hp} / ATK ${d.atk}<br>
        SPD ${d.spd} / 사거리 ${d.range}<br>
        비용: <b>${d.cost}</b>
      </div>`;
    container.appendChild(card);
  }
}

// ─── Summon Buttons ───────────────────────────────────────────────────────────
const summonBtns: HTMLButtonElement[] = [];

function buildSummonButtons() {
  const grid = $('summon-grid');
  grid.innerHTML = '';
  summonBtns.length = 0;
  for (const id of ANIMAL_IDS) {
    const d = ANIMALS[id];
    const btn = document.createElement('button');
    btn.dataset.id = id;
    btn.style.cssText = 'border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);color:#e8eefc;font-weight:700;cursor:pointer;font-size:12px;padding:4px 2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;';
    btn.innerHTML = `<span style="font-size:14px;color:#${d.color.toString(16).padStart(6,'0')}">${d.name}</span><span style="opacity:0.8;font-size:11px;">비용 ${d.cost}</span>`;
    btn.addEventListener('click', () => playerSummon(id));
    grid.appendChild(btn);
    summonBtns.push(btn);
  }
}

function updateSummonButtons() {
  for (const btn of summonBtns) {
    const id = btn.dataset.id!;
    const canAfford = currency >= ANIMALS[id].cost;
    btn.style.opacity = canAfford ? '1' : '0.4';
    btn.style.cursor = canAfford ? 'pointer' : 'not-allowed';
  }
}

function playerSummon(animalId: string) {
  if (!battleActive) return;
  const cost = ANIMALS[animalId].cost;
  if (currency < cost) return;
  currency -= cost;
  updateHud();
  spawnUnit(animalId, 'p1');
  if (gameMode === '2p') {
    socket.emit('battleSpawn', { animalId });
  }
}

// ─── Battle Init ──────────────────────────────────────────────────────────────
function clearBattle() {
  for (const u of [...units]) removeUnitMeshes(u);
  units = [];
  if (p1Base) { scene.remove(p1Base.mesh); scene.remove(p1Base.hpSprite); }
  if (p2Base) { scene.remove(p2Base.mesh); scene.remove(p2Base.hpSprite); }
}

async function startBattle() {
  if (!modelsReady) {
    showLoadingOverlay(true);
    await Promise.race([
      loadAllModels(),
      new Promise<void>(r => setTimeout(r, 5000)), // 5초 초과 시 그냥 시작
    ]);
    showLoadingOverlay(false);
  }
  clearBattle();
  battleActive = true;
  currency = 0;
  autoCurrencyTimer = 0;
  stateSyncTimer = 0;
  camPan = 0;
  round = 1;
  roundTimer = ROUND_DURATION;
  aiSpawnTimer = AI_ROUNDS[0].interval;
  unitIdCounter = 0;

  const enemyBaseHp = gameMode === '1p' ? BASE_HP_1P_ENEMY : BASE_HP;
  p1Base = makeBase(0, 0x3366ff, BASE_HP);
  p2Base = makeBase(FIELD_LEN, 0xff3333, enemyBaseHp);

  buildSummonButtons();
  pickNewWord();
  updateHud();
  showScreen('battle');
  updateCamera();
}

// ─── Camera Update ────────────────────────────────────────────────────────────
function updateCamera() {
  const lookZ = FIELD_LEN / 2 + camPan;
  if (localSide === 'p1') {
    camera.position.set(8, 5, lookZ);
    camera.lookAt(0, 2, lookZ);
  } else {
    camera.position.set(-8, 5, lookZ);
    camera.lookAt(0, 2, lookZ);
  }
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function updateHud() {
  $('hud-currency').textContent = `재화: ${currency} / ${CURRENCY_MAX}`;
  updateSummonButtons();
  if (gameMode === '1p') {
    $('hud-round').textContent = `라운드 ${round}/${AI_ROUNDS.length}`;
    $('hud-timer').textContent = `${Math.ceil(roundTimer)}초`;
  }
  $('hud-base').textContent = `내 기지 ${Math.ceil(p1Base?.hp ?? 0)} / ${p1Base?.maxHp ?? 0}`;
}

// ─── 1P AI ───────────────────────────────────────────────────────────────────
function step1PAI(dt: number) {
  roundTimer -= dt;
  aiSpawnTimer -= dt;

  const roundIdx = Math.min(round - 1, AI_ROUNDS.length - 1);
  const roundCfg = AI_ROUNDS[roundIdx];

  if (aiSpawnTimer <= 0) {
    aiSpawnTimer = roundCfg.interval * (0.8 + Math.random() * 0.4);
    const pool = roundCfg.pool;
    const id = pool[Math.floor(Math.random() * pool.length)];
    spawnUnit(id, 'p2');
  }

  if (roundTimer <= 0) {
    if (round >= AI_ROUNDS.length) {
      endBattle('win');
    } else {
      round++;
      roundTimer = ROUND_DURATION;
      aiSpawnTimer = AI_ROUNDS[Math.min(round - 1, AI_ROUNDS.length - 1)].interval;
    }
  }
}

function checkWinLose() {
  if (!battleActive) return;
  if (p1Base.hp <= 0) { endBattle('lose'); return; }
  if (p2Base.hp <= 0) { endBattle('win'); return; }
}

function endBattle(result: 'win' | 'lose') {
  battleActive = false;
  $('result-text').textContent = result === 'win' ? '🎉 승리!' : '💀 패배...';
  if (gameMode === '2p') socket.emit('battleResult', { result });
  showScreen('result');
}

// ─── Word Quiz ────────────────────────────────────────────────────────────────
function pickNewWord() {
  const idx = Math.floor(Math.random() * wordList.length);
  currentWord = wordList[idx];
  const wrong: string[] = [];
  const used = new Set([idx]);
  while (wrong.length < 2) {
    const ri = Math.floor(Math.random() * wordList.length);
    if (!used.has(ri)) { used.add(ri); wrong.push(wordList[ri].korean); }
  }
  const all = [currentWord.korean, ...wrong];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  currentChoices = all;
  correctIdx = all.indexOf(currentWord.korean);
  renderQuiz();
}

function renderQuiz() {
  $('word-en').textContent = currentWord.english;
  const container = $('choices');
  container.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const btn = document.createElement('button');
    btn.textContent = `${i + 1}. ${currentChoices[i]}`;
    btn.style.cssText = 'flex:1;padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:#e8eefc;font-size:12px;cursor:pointer;text-align:left;';
    btn.addEventListener('click', () => submitChoice(i));
    container.appendChild(btn);
  }
}

function submitChoice(idx: number) {
  if (!battleActive) return;
  if (idx === correctIdx) {
    addCurrency(CURRENCY_MC);
    pickNewWord();
  } else {
    addCurrency(-1);
    showQuizMsg('틀렸습니다 (-1)');
  }
}

function enterTypingMode() {
  if (isTypingMode) { exitTypingMode(); return; }
  isTypingMode = true;
  const inp = $('type-input') as HTMLInputElement;
  inp.style.display = 'flex';
  inp.value = '';
  inp.focus();
  $('btn-type').textContent = '✕ 닫기';
}

function exitTypingMode() {
  isTypingMode = false;
  const inp = $('type-input') as HTMLInputElement;
  inp.style.display = 'none';
  inp.value = '';
  $('btn-type').textContent = 'T 타이핑';
}

($('btn-type') as HTMLButtonElement).addEventListener('click', enterTypingMode);

($('type-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Escape') { exitTypingMode(); return; }
  if (e.code !== 'Enter') return;
  const typed = (e.target as HTMLInputElement).value.trim();
  if (!typed) return;
  const correct = currentWord.answers.some(a => a.trim() === typed || a.trim().replace(/\s/g,'') === typed.replace(/\s/g,''));
  if (correct) {
    addCurrency(CURRENCY_TYPE);
    pickNewWord();
    (e.target as HTMLInputElement).value = '';
    (e.target as HTMLInputElement).focus();
  } else {
    addCurrency(-1);
    showQuizMsg('틀렸습니다 (-1)');
    (e.target as HTMLInputElement).value = '';
  }
});

let quizMsgTimer = 0;
function showQuizMsg(msg: string) {
  $('quiz-msg').textContent = msg;
  quizMsgTimer = 1.5;
}

function addCurrency(amt: number) {
  currency = Math.max(0, Math.min(CURRENCY_MAX, currency + amt));
  updateHud();
}

// Keyboard shortcuts for quiz
window.addEventListener('keydown', (e) => {
  if (currentScreen !== 'battle') return;
  if (e.code === 'KeyT') { enterTypingMode(); return; }
  if (isTypingMode) return;
  if (e.code === 'Digit1') submitChoice(0);
  else if (e.code === 'Digit2') submitChoice(1);
  else if (e.code === 'Digit3') submitChoice(2);
});

// ─── 2P Socket Setup ──────────────────────────────────────────────────────────
socket.on('connect', () => {
  $('lobby-status').textContent = '서버 연결됨';
});
socket.on('disconnect', () => {
  if (currentScreen === 'battle') endBattle('lose');
});
socket.on('joinError', (msg: string) => { $('lobby-status').textContent = `오류: ${msg}`; });

socket.on('battleStart', (payload: { side: Side; opponentNick: string }) => {
  localSide = payload.side;
  startBattle();
});

socket.on('opponentSpawn', (payload: { animalId: string }) => {
  spawnUnit(payload.animalId, localSide === 'p1' ? 'p2' : 'p1');
});

socket.on('opponentLeft', () => {
  if (currentScreen === 'battle') endBattle('win');
  else $('lobby-status').textContent = '상대방이 나갔습니다';
});

// Sync both bases: take the lower HP so state converges across clients
socket.on('opponentState', (payload: { p1BaseHp: number; p2BaseHp: number }) => {
  if (!battleActive) return;
  if (p1Base && payload.p1BaseHp < p1Base.hp) p1Base.hp = payload.p1BaseHp;
  if (p2Base && payload.p2BaseHp < p2Base.hp) p2Base.hp = payload.p2BaseHp;
});

// Opponent's local game determined a result — mirror it
socket.on('opponentResult', (payload: { result: 'win' | 'lose' }) => {
  if (!battleActive) return;
  endBattle(payload.result === 'win' ? 'lose' : 'win');
});

// ─── Menu Button Handlers ──────────────────────────────────────────────────────
$('btn-1p').addEventListener('click', () => {
  gameMode = '1p';
  localSide = 'p1';
  buildDeckCards();
  showScreen('deck');
});

$('btn-2p').addEventListener('click', () => {
  gameMode = '2p';
  const nick = `Player${Math.floor(Math.random() * 900 + 100)}`;
  ($('in-nick') as HTMLInputElement).value = nick;
  showScreen('lobby2p');
});

$('btn-deck-back').addEventListener('click', () => showScreen('menu'));
$('btn-deck-start').addEventListener('click', () => startBattle());

$('btn-lobby-back').addEventListener('click', () => {
  socket.disconnect();
  showScreen('menu');
});

$('btn-rndroom').addEventListener('click', () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += a[Math.floor(Math.random() * a.length)];
  ($('in-room') as HTMLInputElement).value = c;
});

$('btn-joinroom').addEventListener('click', () => {
  const nick = ($('in-nick') as HTMLInputElement).value.trim().slice(0, 16) || 'Player';
  const room = ($('in-room') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!room) { $('lobby-status').textContent = '방 코드를 입력하세요'; return; }
  $('lobby-status').textContent = '연결 중...';
  if (!socket.connected) socket.connect();
  socket.emit('battleJoin', { nickname: nick, roomCode: room });
});

$('btn-result-menu').addEventListener('click', () => {
  clearBattle();
  if (socket.connected) socket.disconnect();
  showScreen('menu');
});

// ─── Main Loop ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateCamera();

  if (battleActive) {
    autoCurrencyTimer += dt;
    if (autoCurrencyTimer >= CURRENCY_AUTO_INTERVAL) {
      autoCurrencyTimer -= CURRENCY_AUTO_INTERVAL;
      addCurrency(1);
    }

    stepUnits(dt);
    syncUnitMeshes();

    if (p1Base.hp !== p1Base.lastHp || p2Base.hp !== p2Base.lastHp) {
      syncBaseMeshes();
      updateHud();
    }

    checkWinLose();

    if (gameMode === '1p') step1PAI(dt);

    if (gameMode === '2p') {
      stateSyncTimer += dt;
      if (stateSyncTimer >= 0.5) {
        stateSyncTimer = 0;
        socket.emit('battleState', { p1BaseHp: p1Base.hp, p2BaseHp: p2Base.hp });
      }
    }

    if (quizMsgTimer > 0) {
      quizMsgTimer -= dt;
      if (quizMsgTimer <= 0) $('quiz-msg').textContent = '';
    }

    updateHud();
  }

  // HP sprites always face camera
  const camPos = camera.position;
  for (const u of units) {
    if (u.hpSprite) u.hpSprite.lookAt(camPos);
  }
  if (p1Base) p1Base.hpSprite.lookAt(camPos);
  if (p2Base) p2Base.hpSprite.lookAt(camPos);

  renderer.render(scene, camera);
}

animate();
