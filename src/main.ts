import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { io } from 'socket.io-client';
import { wordList } from './words';
import { ANIMALS, ANIMAL_IDS, BASE_HP, BASE_HP_1P_ENEMY, FIELD_LEN, SPAWN_P1, SPAWN_P2, AIR_Y } from './animals';
import type { AnimalDef } from './animals';
import { FOODS, FOOD_IDS, isFoodId } from './foods';
import { supabase, toEmail, saveProfile, ensureProfile, DEFAULT_DECK, submitLeaderboard, fetchLeaderboard, deleteMyLeaderboard } from './supabase';
import type { UserProfile, LeaderboardEntry } from './supabase';

// ─── Model Loading ────────────────────────────────────────────────────────────
const MODEL_MAP: Record<string, string> = {
  lion:     'animal-lion',
  elephant: 'animal-elephant',
  eagle:    'animal-parrot',
  monkey:   'animal-monkey',
  mole:     'animal-beaver',
  bee:      'animal-bee',
  bunny:    'animal-bunny',
  cat:      'animal-cat',
  chick:    'animal-chick',
  cow:      'animal-cow',
  crab:     'animal-crab',
  deer:     'animal-deer',
  dog:      'animal-dog',
  fox:      'animal-fox',
  giraffe:  'animal-giraffe',
  hog:      'animal-hog',
  koala:    'animal-koala',
  panda:    'animal-panda',
  penguin:  'animal-penguin',
  pig:      'animal-pig',
  polar:    'animal-polar',
  tiger:    'animal-tiger',
};

const modelTemplates: Record<string, { scene: THREE.Group; animations: THREE.AnimationClip[] }> = {};
let modelsReady = false;
let modelsLoadPromise: Promise<void> | null = null;

function loadAllModels(): Promise<void> {
  if (modelsLoadPromise) return modelsLoadPromise;
  const loader = new GLTFLoader();
  const base = `${import.meta.env.BASE_URL}kenney_cube-pets/Models/GLB%20format/`;
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
                mats.forEach(m => { (m as THREE.MeshStandardMaterial).side = THREE.DoubleSide; });
              }
            });
            modelTemplates[id] = { scene: root, animations: gltf.animations };
            resolve();
          },
          undefined,
          (err) => {
            console.warn(`Failed to load ${name}.glb:`, err);
            resolve();
          }
        );
      })
    )
  ).then(() => { modelsReady = true; });
  return modelsLoadPromise;
}

// 페이지 로드와 동시에 백그라운드에서 모델 로딩 시작
loadAllModels();

// ─── Boss System ──────────────────────────────────────────────────────────────
interface BossDef {
  id: string;
  name: string;
  file: string;        // FBX filename
  hp: number;
  atk: number;
  spd: number;
  atkCooldown: number;
  range: number;
  modelScale: number;  // FBX model scale (tune if needed)
  collisionSize: number; // radius used for HP bar & collision
  aoe?: number;        // AoE radius (dragon)
  animWalk: string;    // animation clip name for walking
  animAtk: string;     // animation clip name for attack
}

const BOSS_DEFS: Record<string, BossDef> = {
  slime: {
    id: 'slime', name: '슬라임', file: 'Slime.fbx',
    hp: 25, atk: 5, spd: 4, atkCooldown: 3/4, range: 2,
    modelScale: 0.0138, collisionSize: 1.0,
    animWalk: 'Slime_Walk', animAtk: 'Slime_Attack',
  },
  bat: {
    id: 'bat', name: '박쥐', file: 'Bat.fbx',
    hp: 50, atk: 10, spd: 3, atkCooldown: 3/3, range: 3,
    modelScale: 0.0083, collisionSize: 1.5,
    animWalk: 'Bat_Flying', animAtk: 'Bat_Attack',
  },
  skeleton: {
    id: 'skeleton', name: '해골', file: 'Skeleton.fbx',
    hp: 100, atk: 15, spd: 2, atkCooldown: 3/2, range: 3,
    modelScale: 0.0101, collisionSize: 2.0,
    animWalk: 'Skeleton_Running', animAtk: 'Skeleton_Attack',
  },
  dragon: {
    id: 'dragon', name: '드레곤', file: 'Dragon.fbx',
    hp: 200, atk: 20, spd: 1, atkCooldown: 3/1, range: 10,
    modelScale: 0.0170, collisionSize: 3.0, // 고정 6유닛 (FBX 원본 353.95 × 0.0170 ≈ 6)
    aoe: 3,
    animWalk: 'Dragon_Flying', animAtk: 'Dragon_Attack', // Attack2 아님, 고정
  },
};

// HP threshold → boss id (p2 base hp drops TO or BELOW this)
const BOSS_THRESHOLDS: { hp: number; bossId: string }[] = [
  { hp: 400, bossId: 'slime' },
  { hp: 300, bossId: 'bat' },
  { hp: 200, bossId: 'skeleton' },
  { hp: 100, bossId: 'dragon' },
];

const bossTemplates: Record<string, THREE.Group | null> = {
  slime: null, bat: null, skeleton: null, dragon: null,
};
let bossTemplatesLoading = false;

// ─── Cute-Monster System ──────────────────────────────────────────────────────
const MONSTER_FILE_MAP: Record<string, string> = {
  m_chicken:'Chicken', m_bee:'Bee', m_mushroom:'Mushroom', m_crab:'Crab',
  m_bat:'Bat', m_penguin:'Penguin', m_pig:'Pig', m_panda:'Panda',
  m_deer:'Deer', m_alien:'Alien', m_ghost:'Ghost', m_skull:'Skull',
  m_greendemon:'GreenDemon', m_cyclops:'Cyclops', m_cactus:'Cactus',
  m_demon:'Demon', m_yeti:'Yeti', m_tree:'Tree', m_alien_tall:'Alien_Tall',
  m_cthulhu:'Cthulhu', m_yellowdragon:'YellowDragon',
};

// Register monster AnimalDefs so AI/movement code can look them up
(function registerMonsters() {
  const S = 0.35, M = 0.5, L = 0.65; // size (collision radius)
  const defs: AnimalDef[] = [
    { id:'m_chicken',    name:'닭',        layer:'ground', attackLayer:'ground', hp:6,  atk:1,   spd:6, atkCooldown:0.4,  range:1, cost:0, size:S, color:0xffe080 },
    { id:'m_bee',        name:'벌',        layer:'air',    attackLayer:'both',   hp:5,  atk:0.5, spd:9, atkCooldown:0.3,  range:3, cost:0, size:S, color:0xffcc00 },
    { id:'m_mushroom',   name:'버섯',      layer:'ground', attackLayer:'ground', hp:10, atk:1,   spd:2, atkCooldown:0.6,  range:1, cost:0, size:S, color:0xcc6633 },
    { id:'m_crab',       name:'게',        layer:'ground', attackLayer:'ground', hp:10, atk:2,   spd:4, atkCooldown:0.5,  range:1, cost:0, size:S, color:0xcc4420 },
    { id:'m_bat',        name:'박쥐',      layer:'air',    attackLayer:'both',   hp:10, atk:2,   spd:7, atkCooldown:0.5,  range:2, cost:0, size:S, color:0x7755aa },
    { id:'m_penguin',    name:'펭귄',      layer:'ground', attackLayer:'ground', hp:14, atk:1,   spd:2, atkCooldown:0.5,  range:1, cost:0, size:S, color:0x202020 },
    { id:'m_pig',        name:'돼지',      layer:'ground', attackLayer:'ground', hp:16, atk:2,   spd:3, atkCooldown:0.8,  range:1, cost:0, size:M, color:0xffaaaa },
    { id:'m_panda',      name:'판다',      layer:'ground', attackLayer:'ground', hp:20, atk:3,   spd:2, atkCooldown:1.0,  range:1, cost:0, size:M, color:0xdddddd },
    { id:'m_deer',       name:'사슴',      layer:'ground', attackLayer:'ground', hp:16, atk:3,   spd:5, atkCooldown:0.6,  range:1, cost:0, size:M, color:0xc09060 },
    { id:'m_alien',      name:'에일리언',  layer:'ground', attackLayer:'ground', hp:18, atk:3,   spd:4, atkCooldown:0.6,  range:1, cost:0, size:M, color:0x44cc88 },
    { id:'m_ghost',      name:'유령',      layer:'ground', attackLayer:'both',   hp:14, atk:3,   spd:5, atkCooldown:0.5,  range:2, cost:0, size:M, color:0xffffff },
    { id:'m_skull',      name:'해골',      layer:'ground', attackLayer:'ground', hp:18, atk:4,   spd:3, atkCooldown:0.7,  range:1, cost:0, size:M, color:0xeeeecc },
    { id:'m_greendemon', name:'초록악마',  layer:'ground', attackLayer:'both',   hp:22, atk:4,   spd:4, atkCooldown:0.75, range:4, cost:0, size:M, color:0x44aa44, ranged:true },
    { id:'m_cyclops',    name:'외눈괴물',  layer:'ground', attackLayer:'ground', hp:26, atk:6,   spd:3, atkCooldown:1.0,  range:1, cost:0, size:M, color:0x5588bb },
    { id:'m_cactus',     name:'선인장',    layer:'ground', attackLayer:'both',   hp:20, atk:4,   spd:2, atkCooldown:0.75, range:5, cost:0, size:M, color:0x55aa55, ranged:true },
    { id:'m_demon',      name:'악마',      layer:'ground', attackLayer:'both',   hp:22, atk:6,   spd:5, atkCooldown:0.5,  range:2, cost:0, size:M, color:0xcc3333 },
    { id:'m_yeti',       name:'예티',      layer:'ground', attackLayer:'ground', hp:32, atk:6,   spd:3, atkCooldown:1.0,  range:1, cost:0, size:L, color:0xaaddff },
    { id:'m_tree',       name:'나무괴물',  layer:'ground', attackLayer:'ground', hp:40, atk:5,   spd:2, atkCooldown:1.5,  range:2, cost:0, size:L, color:0x886644 },
    { id:'m_alien_tall', name:'키큰에일리언', layer:'ground', attackLayer:'both', hp:26, atk:7,  spd:4, atkCooldown:0.75, range:4, cost:0, size:L, color:0x88ddaa, ranged:true },
    { id:'m_cthulhu',    name:'크툴루',    layer:'air',    attackLayer:'both',   hp:35, atk:8,   spd:3, atkCooldown:1.0,  range:5, cost:0, size:L, color:0x336688, ranged:true },
    { id:'m_yellowdragon',name:'황룡',     layer:'air',    attackLayer:'both',   hp:50, atk:10,  spd:4, atkCooldown:0.5,  range:6, cost:0, size:L, color:0xffcc00, ranged:true },
  ];
  for (const def of defs) (ANIMALS as Record<string, AnimalDef>)[def.id] = def;
})();

let monsterModelsLoading = false;
function loadMonsterModels(): Promise<void> {
  if (monsterModelsLoading) return Promise.resolve();
  monsterModelsLoading = true;
  const loader = new GLTFLoader();
  const base = `${import.meta.env.BASE_URL}cute-monster/glTF/`;
  const tasks = Object.entries(MONSTER_FILE_MAP).map(([id, file]) =>
    new Promise<void>(resolve => {
      loader.load(`${base}${file}.gltf`, gltf => {
        modelTemplates[id] = { scene: gltf.scene, animations: gltf.animations };
        resolve();
      }, undefined, () => resolve());
    })
  );
  return Promise.all(tasks).then(() => {});
}

// ─── Boss Spawn Effects ───────────────────────────────────────────────────────
interface BossSpawnEffect { ring: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; }
const bossSpawnEffects: BossSpawnEffect[] = [];

function triggerBossSpawnEffect(z: number) {
  const geo = new THREE.RingGeometry(0.2, 1, 48);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 1, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.15, z);
  scene.add(ring);
  bossSpawnEffects.push({ ring, mat, age: 0 });
}

function updateBossSpawnEffects(dt: number) {
  const DURATION = 1.2;
  const MAX_SCALE = 10;
  for (let i = bossSpawnEffects.length - 1; i >= 0; i--) {
    const e = bossSpawnEffects[i];
    e.age += dt;
    const t = e.age / DURATION;
    if (t >= 1) { scene.remove(e.ring); bossSpawnEffects.splice(i, 1); continue; }
    e.ring.scale.setScalar(1 + MAX_SCALE * t);
    e.mat.opacity = 1 - t;
  }
}

function loadBossModels(): Promise<void> {
  if (bossTemplatesLoading) return Promise.resolve();
  bossTemplatesLoading = true;
  const bossBase = `${import.meta.env.BASE_URL}boss/`;
  console.log('[Boss] loading FBX from base:', bossBase);
  const loader = new FBXLoader();
  const tasks = Object.values(BOSS_DEFS).map(def =>
    new Promise<void>(resolve => {
      loader.load(`${bossBase}${def.file}`, (fbx) => {
        bossTemplates[def.id] = fbx;
        const box = new THREE.Box3().setFromObject(fbx);
        const sz = box.getSize(new THREE.Vector3());
        console.log(`[Boss] loaded ${def.file} | size at scale 1:`, sz.x.toFixed(2), sz.y.toFixed(2), sz.z.toFixed(2), '| animations:', fbx.animations.map(a => a.name));
        resolve();
      }, undefined, (err) => {
        console.error(`[Boss] FAILED to load ${def.file}:`, err);
        resolve();
      });
    })
  );
  return Promise.all(tasks).then(() => { console.log('[Boss] all models loaded'); });
}

// ─── Food Model Loading ──────────────────────────────────────────────────────
const foodTemplates: Record<string, THREE.Group | null> = {};
const foodModelScales: Record<string, number> = {}; // computed scale to match desired game-unit size
let foodTemplatesLoading = false;

function loadFoodModels(): Promise<void> {
  if (foodTemplatesLoading) return Promise.resolve();
  foodTemplatesLoading = true;
  const foodBase = `${import.meta.env.BASE_URL}food/FBX/`;
  // Also load Coconut_Half for the split animation
  const extraFiles: { id: string; file: string; size: number }[] = [
    { id: 'coconut_half', file: 'Coconut_Half.fbx', size: 0.18 },
  ];
  const loader = new FBXLoader();
  const tasks: Promise<void>[] = [];
  const loadOne = (id: string, file: string, targetSize: number) => {
    return new Promise<void>(resolve => {
      loader.load(`${foodBase}${file}`, (fbx) => {
        foodTemplates[id] = fbx;
        const box = new THREE.Box3().setFromObject(fbx);
        const sz = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(sz.x, sz.y, sz.z);
        const scale = maxDim > 0 ? (targetSize * 2) / maxDim : 1;
        foodModelScales[id] = scale;
        // FBX materials are lighting-dependent → add emissive so they look
        // vibrant regardless of scene light angles
        fbx.traverse((child: THREE.Object3D) => {
          if (!(child as THREE.Mesh).isMesh) return;
          const mats = Array.isArray((child as THREE.Mesh).material)
            ? (child as THREE.Mesh).material as THREE.Material[]
            : [(child as THREE.Mesh).material as THREE.Material];
          mats.forEach(m => {
            const mat = m as THREE.MeshPhongMaterial;
            if (mat.emissive !== undefined && mat.color !== undefined) {
              mat.emissive.copy(mat.color).multiplyScalar(0.55);
            }
          });
        });
        console.log(`[Food] loaded ${file} | raw size:`, sz.x.toFixed(2), sz.y.toFixed(2), sz.z.toFixed(2), '| scale:', scale.toFixed(4));
        resolve();
      }, undefined, (err) => {
        console.warn(`[Food] FAILED to load ${file}:`, err);
        resolve();
      });
    });
  };
  for (const def of Object.values(FOODS)) {
    foodTemplates[def.id] = null;
    tasks.push(loadOne(def.id, def.fbxFile, def.size));
  }
  for (const ex of extraFiles) {
    foodTemplates[ex.id] = null;
    tasks.push(loadOne(ex.id, ex.file, ex.size));
  }
  return Promise.all(tasks).then(() => { console.log('[Food] all models loaded'); });
}

function makeFoodMesh(foodId: string): THREE.Object3D {
  const tmpl = foodTemplates[foodId];
  if (tmpl) {
    const m = skeletonClone(tmpl) as THREE.Group;
    const s = foodModelScales[foodId] ?? 1;
    m.scale.setScalar(s);
    return m;
  }
  // Fallback: colored sphere
  const def = FOODS[foodId];
  const size = def?.size ?? 0.2;
  const color = def?.color ?? 0xffffff;
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(size, 12, 8),
    new THREE.MeshStandardMaterial({ color })
  );
  return mesh;
}

// FBX AnimationMixer helper: find clip by name substring
function findClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip | undefined {
  return clips.find(c => c.name.includes(name)) ?? clips[0];
}

let bossSpawned: Record<string, boolean> = {};

function resetBossSpawned() {
  bossSpawned = { slime: false, bat: false, skeleton: false, dragon: false };
}

function spawnBoss(bossId: string): void {
  console.log(`[Boss] spawnBoss called: ${bossId}`);
  const def = BOSS_DEFS[bossId];
  const tmpl = bossTemplates[bossId];
  console.log(`[Boss] template loaded: ${!!tmpl}, def:`, def);

  // Create mesh from FBX template or fallback box
  let mesh: THREE.Object3D;
  let mixer: THREE.AnimationMixer | null = null;
  let currentAnim = '';
  const walkClipName = def.animWalk;

  if (tmpl) {
    // SkeletonUtils.clone properly rebinds bones — regular .clone(true) breaks SkinnedMesh
    mesh = skeletonClone(tmpl) as THREE.Group;
    mesh.scale.setScalar(def.modelScale);
    mesh.rotation.y = Math.PI; // p2 unit faces toward p1 (negative z)

    // Animations are on the original template; mixer resolves by bone name so it works with clone
    const clips = tmpl.animations;
    mixer = new THREE.AnimationMixer(mesh);
    const walkClip = findClip(clips, walkClipName);
    if (walkClip) {
      mixer.clipAction(walkClip).play();
      currentAnim = walkClipName;
    }
  } else {
    // Fallback colored box
    mesh = new THREE.Mesh(
      new THREE.BoxGeometry(def.collisionSize * 2, def.collisionSize * 2, def.collisionSize * 2),
      new THREE.MeshStandardMaterial({ color: 0xff4400 })
    );
  }

  const z = SPAWN_P2;
  const x = 0;
  const yPos = 0; // FBX model feet at origin — grounded
  mesh.position.set(x, yPos, z);
  scene.add(mesh);

  const hpSprite = makeHpSprite(def.hp, def.hp);
  hpSprite.position.set(x, def.collisionSize + 1.2, z);
  scene.add(hpSprite);

  // "보스" label above HP bar
  const bossLabel = makeTextSprite(`👑 ${def.name} 보스`, '#ffdd00', 2.5);
  bossLabel.position.set(x, def.collisionSize + 2.4, z);
  scene.add(bossLabel);

  // Build a pseudo-AnimalDef so the existing AI/movement code works
  const pseudoDef: AnimalDef = {
    id: bossId as string,
    name: def.name,
    layer: 'ground',
    attackLayer: 'both',
    hp: def.hp, atk: def.atk, spd: def.spd,
    atkCooldown: def.atkCooldown,
    range: def.range,
    cost: 0, size: def.collisionSize,
    color: 0xff4400,
    baseY: 0, // FBX model origin is at feet — keep boss grounded
    ...(def.aoe ? { aoe: def.aoe } : {}),
  };
  // Register pseudo-def so AI code can look it up
  (ANIMALS as Record<string, AnimalDef>)[bossId] = pseudoDef;

  const unit: UnitSim = {
    id: `boss_${bossId}_${++unitIdCounter}`,
    animalId: bossId,
    side: 'p2',
    z, x,
    hp: def.hp, maxHp: def.hp,
    state: 'moving',
    atkTimer: 0,
    mesh, hpSprite, dustMesh: null,
    lastHp: def.hp,
    mixer, currentAnim,
    bossLabel,
  } as UnitSim & { bossLabel: THREE.Sprite };

  units.push(unit);
  console.log(`[Boss] unit pushed, mesh at (${x}, ${yPos}, ${z}), scene children: ${scene.children.length}`);
}

// ─── Environment Assets ───────────────────────────────────────────────────────
const tdBase     = `${import.meta.env.BASE_URL}kenney_tower-defense-kit/Models/GLB%20format/`;
const castleBase = `${import.meta.env.BASE_URL}kenney_castle-kit/Models/GLB%20format/`;

type Team = 'red' | 'violet';
let p1Team: Team = 'red';
let p2Team: Team = 'violet';
let myTeam: Team = 'red';
let foeTeam: Team = 'violet';

// RED: tower-round-top-c / tower-round-build-b / tower-round-build-e
// VIOLET: tower-square-top-c / tower-square-build-c / tower-square-build-f
const redTowerTemplates: (THREE.Group | null)[] = Array(3).fill(null);
const violetTowerTemplates: (THREE.Group | null)[] = Array(3).fill(null);
let p1TowerMesh: THREE.Group | null = null;
let p2TowerMesh: THREE.Group | null = null;
const baseTowerMeshes: THREE.Object3D[] = [];

function tintClone(template: THREE.Group): THREE.Group {
  const model = template.clone(true);
  model.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(m => m.clone())
        : (mesh.material as THREE.Material).clone();
      mesh.castShadow = true;
    }
  });
  return model;
}

const RED_TOWER_FILES   = ['tower-round-top-c',   'tower-round-build-b',   'tower-round-build-e'];
const VIOLET_TOWER_FILES = ['tower-square-top-c', 'tower-square-build-c', 'tower-square-build-f'];

function loadEnvironment() {
  const loader = new GLTFLoader();
  RED_TOWER_FILES.forEach((name, i) => {
    loader.load(`${tdBase}${name}.glb`, g => {
      redTowerTemplates[i] = g.scene;
      if (battleActive) { updateTowerVisual('p1'); updateTowerVisual('p2'); }
    }, undefined, err => { console.warn(`${name}.glb 로딩 실패:`, err); });
  });
  VIOLET_TOWER_FILES.forEach((name, i) => {
    loader.load(`${tdBase}${name}.glb`, g => {
      violetTowerTemplates[i] = g.scene;
      if (battleActive) { updateTowerVisual('p1'); updateTowerVisual('p2'); }
    }, undefined, err => { console.warn(`${name}.glb 로딩 실패:`, err); });
  });

  // 성벽 로딩
  let wallT: THREE.Group | null = null;
  let cornerT: THREE.Group | null = null;
  let wallLoaded = 0;
  const onWallLoaded = () => { if (++wallLoaded === 2 && wallT && cornerT) placePerimeterWalls(wallT, cornerT); };
  loader.load(`${castleBase}wall.glb`,        g => { wallT   = g.scene; onWallLoaded(); }, undefined, () => {});
  loader.load(`${castleBase}wall-corner.glb`, g => { cornerT = g.scene; onWallLoaded(); }, undefined, () => {});
}
loadEnvironment();

function placePerimeterWalls(wallT: THREE.Group, _cornerT: THREE.Group) {
  const wsz = new THREE.Box3().setFromObject(wallT).getSize(new THREE.Vector3());
  const tw   = Math.max(wsz.x, wsz.z);
  const SCALE = 2.5;
  const tileW = tw * SCALE;

  // 벽 외곽 — 땅과 같은 범위
  const X0 = -10, X1 = 10;
  const Z0 = -10, Z1 = FIELD_LEN + 10;

  const put = (x: number, z: number, ry: number) => {
    const m = wallT.clone(true);
    m.position.set(x, 0, z);
    m.rotation.y = ry;
    m.scale.setScalar(SCALE);
    (m as any).__isWall = true;
    scene.add(m);
  };

  // 전체 span을 균등 분배 → 모서리까지 빈틈 없이 채움
  const fillZ = (x: number, ry: number) => {
    const n = Math.round((Z1 - Z0) / tileW);
    for (let i = 0; i < n; i++) put(x, Z0 + (i + 0.5) * (Z1 - Z0) / n, ry);
  };
  const fillX = (z: number, ry: number) => {
    const n = Math.round((X1 - X0) / tileW);
    for (let i = 0; i < n; i++) put(X0 + (i + 0.5) * (X1 - X0) / n, z, ry);
  };

  fillZ(X0,  0);             // 좌측 긴 벽
  fillZ(X1,  Math.PI);       // 우측 긴 벽
  fillX(Z0, -Math.PI / 2);   // 하단 짧은 벽
  fillX(Z1,  Math.PI / 2);   // 상단 짧은 벽
}

function updateTowerVisual(side: Side) {
  if (!p1Base || !p2Base) return;
  const level = side === 'p1' ? p1TowerLevel : p2TowerLevel;
  const team  = side === 'p1' ? p1Team : p2Team;
  const lastStage = side === 'p1' ? p1TowerLastStage : p2TowerLastStage;
  if (level === lastStage) return;
  const templates = team === 'red' ? redTowerTemplates : violetTowerTemplates;
  const template = templates[level];
  if (!template) return;
  if (side === 'p1') p1TowerLastStage = level; else p2TowerLastStage = level;
  const newMesh = tintClone(template);
  // scale: level 0 = 2.0, level 1 = 3.0, level 2 = 4.0 (doubles at max)
  newMesh.scale.setScalar(2.0 * (1 + level * 0.5));
  newMesh.position.set(0, 0.4, side === 'p1' ? 2 : FIELD_LEN - 2);
  const oldMesh = side === 'p1' ? p1TowerMesh : p2TowerMesh;
  if (oldMesh) {
    scene.remove(oldMesh);
    const idx = baseTowerMeshes.indexOf(oldMesh);
    if (idx >= 0) baseTowerMeshes.splice(idx, 1);
  }
  if (side === 'p1') p1TowerMesh = newMesh; else p2TowerMesh = newMesh;
  scene.add(newMesh);
  baseTowerMeshes.push(newMesh);
}

function placeBaseTowers() {
  for (const m of baseTowerMeshes) scene.remove(m);
  baseTowerMeshes.length = 0;
  p1TowerMesh = null;
  p2TowerMesh = null;
  p1TowerLastStage = -1;
  p2TowerLastStage = -1;
  updateTowerVisual('p1');
  updateTowerVisual('p2');
}

// ─── Tower Upgrade ────────────────────────────────────────────────────────────
let p1TowerLevel = 0; // 0-2: initial / mid / max
let p2TowerLevel = 0;
let p1TowerLastStage = -1;
let p2TowerLastStage = -1;
const HP_PER_UPGRADE = 100;  // 2 upgrades: 100 → 200 → 300
const UPGRADE_COSTS = [10, 15];
const BASE_HEAL_COST = 3;
const BASE_HEAL_AMOUNT = 20;

// ─── Siege Weapons ────────────────────────────────────────────────────────────
interface SiegeWeapon {
  type: 'ballista' | 'catapult';
  side: Side;
  z: number;
  x: number;
  mesh: THREE.Group | null;
  atkTimer: number;
}

interface Projectile {
  type: 'arrow' | 'boulder';
  mesh: THREE.Object3D | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  damage: number;
  aoe: number;
  side: Side;
  done: boolean;
}

const SIEGE_COST = 10;
const BALLISTA_RANGE = 10;
const CATAPULT_RANGE = 10;
const BOULDER_GRAVITY = 20;
const BOULDER_H_SPEED = 9;

let p1Ballista: SiegeWeapon | null = null;
let p1Catapult: SiegeWeapon | null = null;
let p2Ballista: SiegeWeapon | null = null;
let p2Catapult: SiegeWeapon | null = null;
const projectiles: Projectile[] = [];

const siegeWeaponTemplates: Record<string, THREE.Group | null> = {
  ballista: null, catapult: null, arrow: null, boulder: null,
};

function loadSiegeWeapons() {
  const loader = new GLTFLoader();
  const files: Record<string, string> = {
    ballista: 'weapon-ballista',
    catapult: 'weapon-catapult',
    arrow:    'weapon-ammo-arrow',
    boulder:  'weapon-ammo-boulder',
  };
  for (const [key, name] of Object.entries(files)) {
    loader.load(`${tdBase}${name}.glb`, g => {
      siegeWeaponTemplates[key] = g.scene;
    }, undefined, () => {});
  }
}
loadSiegeWeapons();

function buySiege(type: 'ballista' | 'catapult') {
  if (!battleActive) return;
  const mySiege = localSide === 'p1'
    ? (type === 'ballista' ? p1Ballista : p1Catapult)
    : (type === 'ballista' ? p2Ballista : p2Catapult);
  if (mySiege) return;
  if (currency < SIEGE_COST) return;
  currency -= SIEGE_COST;
  if (gameMode === '1p') {
    placeSiege(type, localSide);
  } else {
    socket.emit('battleSiege', { type }); // server places and validates
  }
  updateHud();
  updateSiegeButtons();
}

function syncSiegeMeshes(state: Record<string, { x: number; z: number } | null>) {
  const entries: Array<[string, Side, 'ballista' | 'catapult']> = [
    ['p1Ballista', 'p1', 'ballista'],
    ['p1Catapult', 'p1', 'catapult'],
    ['p2Ballista', 'p2', 'ballista'],
    ['p2Catapult', 'p2', 'catapult'],
  ];
  for (const [key, side, type] of entries) {
    const data = state[key];
    const sw = side === 'p1'
      ? (type === 'ballista' ? p1Ballista : p1Catapult)
      : (type === 'ballista' ? p2Ballista : p2Catapult);
    if (data && !sw) placeSiege(type, side);
  }
}

function placeSiege(type: 'ballista' | 'catapult', side: Side) {
  const baseZ = side === 'p1' ? 2 : FIELD_LEN - 2;
  const xOffset = type === 'ballista' ? 3 : -3;
  const weapon: SiegeWeapon = { type, side, z: baseZ, x: xOffset, mesh: null, atkTimer: 0 };

  const tmpl = siegeWeaponTemplates[type];
  if (tmpl) {
    weapon.mesh = tmpl.clone(true);
    weapon.mesh.scale.setScalar(6.0);
    weapon.mesh.position.set(xOffset, 0, baseZ);
    if (side === 'p2') weapon.mesh.rotation.y = Math.PI;
    scene.add(weapon.mesh);
  }

  if (side === 'p1') {
    if (type === 'ballista') p1Ballista = weapon; else p1Catapult = weapon;
  } else {
    if (type === 'ballista') p2Ballista = weapon; else p2Catapult = weapon;
  }
}

function stepSiegeWeapons(dt: number) {
  for (const sw of [p1Ballista, p1Catapult, p2Ballista, p2Catapult]) {
    if (!sw) continue;
    sw.atkTimer = Math.max(0, sw.atkTimer - dt);
    if (sw.atkTimer > 0) continue;

    const enemies = units.filter(e => e.side !== sw.side && e.state !== 'dead' && e.state !== 'underground');
    const range = sw.type === 'ballista' ? BALLISTA_RANGE : CATAPULT_RANGE;
    const inRange = enemies.filter(e => Math.abs(e.z - sw.z) <= range);
    if (inRange.length === 0) continue;

    const target = inRange.reduce((a, b) => {
      const da = Math.abs(a.z - sw.z);
      const db = Math.abs(b.z - sw.z);
      return da < db ? a : b;
    });

    if (sw.type === 'ballista') {
      sw.atkTimer = 0.3; // atk speed 10
      fireArrow(sw, target);
    } else {
      sw.atkTimer = 3.0; // atk speed 1
      fireBoulder(sw, target);
    }
  }
}

function fireArrow(sw: SiegeWeapon, target: UnitSim) {
  const from = new THREE.Vector3(sw.x, 1.5, sw.z);
  const to = new THREE.Vector3(target.x, target.mesh?.position.y ?? 1, target.z);
  const dir = to.clone().sub(from).normalize();
  const speed = 15;

  const tmpl = siegeWeaponTemplates.arrow;
  let mesh: THREE.Object3D | null = null;
  if (tmpl) {
    mesh = tmpl.clone(true);
    mesh.scale.setScalar(1.5);
    mesh.position.copy(from);
    // Rotate arrow to point in movement direction
    mesh.lookAt(to);
    scene.add(mesh);
  }

  projectiles.push({
    type: 'arrow', mesh, side: sw.side,
    pos: from.clone(), vel: dir.multiplyScalar(speed),
    damage: 1, aoe: 0, done: false,
  });
}

function fireBoulder(sw: SiegeWeapon, target: UnitSim) {
  const from = new THREE.Vector3(sw.x, 1.5, sw.z);
  const to = new THREE.Vector3(target.x, 0, target.z);
  const horizDist = Math.sqrt((to.x-from.x)**2 + (to.z-from.z)**2);
  const tFlight = horizDist / BOULDER_H_SPEED;
  const vy0 = 0.5 * BOULDER_GRAVITY * tFlight;

  const horizDir = new THREE.Vector3(to.x-from.x, 0, to.z-from.z).normalize();
  const vel = horizDir.multiplyScalar(BOULDER_H_SPEED);
  vel.y = vy0;

  const tmpl = siegeWeaponTemplates.boulder;
  let mesh: THREE.Object3D | null = null;
  if (tmpl) {
    mesh = tmpl.clone(true);
    mesh.scale.setScalar(3.0);
    mesh.position.copy(from);
    scene.add(mesh);
  }

  projectiles.push({
    type: 'boulder', mesh, side: sw.side,
    pos: from.clone(), vel,
    damage: 10, aoe: 2.5, done: false,
  });
}

function stepProjectiles(dt: number) {
  for (const p of projectiles) {
    if (p.done) continue;

    if (p.type === 'boulder') p.vel.y -= BOULDER_GRAVITY * dt;
    p.pos.addScaledVector(p.vel, dt);

    if (p.mesh) p.mesh.position.copy(p.pos);

    // Arrow: check hit on enemy units
    if (p.type === 'arrow') {
      const enemies = units.filter(e => e.side !== p.side && e.state !== 'dead' && e.state !== 'underground');
      for (const e of enemies) {
        const eMesh = e.mesh;
        const ey = eMesh ? eMesh.position.y : (ANIMALS[e.animalId].layer === 'air' ? AIR_Y : 0);
        const dist = Math.sqrt((p.pos.x-e.x)**2 + (p.pos.y-ey)**2 + (p.pos.z-e.z)**2);
        if (dist < ANIMALS[e.animalId].size + 0.3) {
          e.hp = Math.max(0, e.hp - p.damage);
          if (e.hp <= 0) e.state = 'dead';
          p.done = true;
          break;
        }
      }
      // Miss if arrow goes too far
      if (!p.done && Math.abs(p.pos.z - (p.side === 'p1' ? FIELD_LEN : 0)) < 1) p.done = true;
    }

    // Boulder: hits ground or air unit
    if (p.type === 'boulder') {
      // Check air unit hits mid-flight
      const airEnemies = units.filter(e => e.side !== p.side && e.state !== 'dead' && ANIMALS[e.animalId].layer === 'air');
      for (const e of airEnemies) {
        const dist = Math.sqrt((p.pos.x-e.x)**2 + (p.pos.y-AIR_Y)**2 + (p.pos.z-e.z)**2);
        if (dist < ANIMALS[e.animalId].size + 0.6) {
          // AoE on nearby air units
          for (const ae of airEnemies) {
            const ad = Math.sqrt((ae.x-e.x)**2 + (ae.z-e.z)**2);
            if (ad <= p.aoe) { ae.hp = Math.max(0, ae.hp - p.damage); if (ae.hp <= 0) ae.state = 'dead'; }
          }
          p.done = true; break;
        }
      }
      // Hits ground
      if (!p.done && p.pos.y <= 0) {
        p.pos.y = 0;
        const groundEnemies = units.filter(e => e.side !== p.side && e.state !== 'dead' && ANIMALS[e.animalId].layer !== 'air');
        for (const ge of groundEnemies) {
          const gd = Math.sqrt((ge.x-p.pos.x)**2 + (ge.z-p.pos.z)**2);
          if (gd <= p.aoe) { ge.hp = Math.max(0, ge.hp - p.damage); if (ge.hp <= 0) ge.state = 'dead'; }
        }
        p.done = true;
      }
    }
  }

  // Clean up done projectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    if (projectiles[i].done) {
      const m = projectiles[i].mesh;
      if (m) scene.remove(m);
      projectiles.splice(i, 1);
    }
  }
}

function clearSiegeWeapons() {
  for (const sw of [p1Ballista, p1Catapult, p2Ballista, p2Catapult]) {
    if (sw?.mesh) scene.remove(sw.mesh);
  }
  p1Ballista = null; p1Catapult = null; p2Ballista = null; p2Catapult = null;
  for (const p of projectiles) { if (p.mesh) scene.remove(p.mesh); }
  projectiles.length = 0;
}

// ─── Food Magic System ───────────────────────────────────────────────────────
type FoodProjType =
  | 'parabola_homing_ally'  // apple, apple_green, pepper_green
  | 'parabola_homing_enemy' // orange, pepper_red, eggplant
  | 'parabola_lob'          // avocado (ballistic)
  | 'mortar_drop'           // coconut (vertical drop from sky)
  | 'homing_missile'        // tomato, egg (pure homing, no gravity)
  | 'banana'                // boomerang
  | 'roll'                  // pumpkin
  | 'turnip'                // vertical jump
  | 'carrot_chain';         // spiraling chain-bounce carrot

interface FoodProj {
  food: string;
  effect: import('./foods').FoodEffect;
  type: FoodProjType;
  side: Side;
  mesh: THREE.Object3D | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  done: boolean;
  age: number;
  damage: number;
  // type-specific data
  target?: UnitSim | null;
  basePos?: THREE.Vector3;       // banana origin
  returnPhase?: boolean;
  hitEnemies?: Set<string>;      // banana piercing
  spinAxis?: THREE.Vector3;
  spinSpeed?: number;
  rollDistMax?: number;
  rollDistAcc?: number;
  splitOnLand?: boolean;         // coconut
  spawnChickOnImpact?: boolean;  // egg
  zoneOnLand?: 'eggplant_dot';
  aoe?: number;
  // carrot_chain fields
  chainHitEnemies?: Set<string>;
  orbitAngle?: number;
  orbitRadius?: number;
  // turnip fields
  hitEnemies2?: Set<string>;     // hit set for downward phase
  turnipPhase?: 'up' | 'down';
}

type FoodZoneType = 'avocado_slow' | 'eggplant_dot' | 'lettuce_mine' | 'carrot_spike' | 'mushroom_paralyze';

interface FoodZone {
  food: string;
  type: FoodZoneType;
  side: Side;
  mesh: THREE.Object3D;
  ringMesh?: THREE.Mesh;
  pos: THREE.Vector3;
  radius: number;
  endTime: number;
  damagePerSec?: number;
  damageOnContact?: number;
  paralyzeDuration?: number;
  slowFactor?: number;
  used?: boolean;
  ageInjected?: number;
}

const foodProjectiles: FoodProj[] = [];
const foodZones: FoodZone[] = [];
let broccoliUnits: { p1: UnitSim | null; p2: UnitSim | null } = { p1: null, p2: null };

// ─── Coconut shockwave ────────────────────────────────────────────────────────
interface CoconutShockwave {
  ring: THREE.Mesh; mat: THREE.MeshBasicMaterial;
  age: number; x: number; z: number;
  side: Side; damage: number; maxRadius: number;
  hitEnemies: Set<string>;
}
const coconutShockwaves: CoconutShockwave[] = [];

function triggerCoconutShockwave(x: number, z: number, side: Side, damage: number, maxRadius: number) {
  const geo = new THREE.RingGeometry(0.4, 1.5, 48);
  const mat = new THREE.MeshBasicMaterial({ color: 0xaa6622, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(geo, mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, 0.18, z);
  scene.add(ring);
  coconutShockwaves.push({ ring, mat, age: 0, x, z, side, damage, maxRadius, hitEnemies: new Set() });
}

function stepCoconutShockwaves(dt: number) {
  const DURATION = 1.6;
  for (let i = coconutShockwaves.length - 1; i >= 0; i--) {
    const sw = coconutShockwaves[i];
    sw.age += dt;
    const t = sw.age / DURATION;
    if (t >= 1) { scene.remove(sw.ring); coconutShockwaves.splice(i, 1); continue; }
    const curRadius = t * sw.maxRadius;
    sw.ring.scale.setScalar(curRadius);
    sw.mat.opacity = (1 - t) * 0.85;
    // Damage enemies as the shockwave sweeps over them (once each)
    for (const u of units) {
      if (u.side === sw.side || u.state === 'dead') continue;
      if (sw.hitEnemies.has(u.id)) continue;
      const d = Math.sqrt((u.x - sw.x) ** 2 + (u.z - sw.z) ** 2);
      if (d < curRadius) {
        u.hp = Math.max(0, u.hp - sw.damage);
        if (u.hp <= 0) { u.state = 'dead'; sfx('death'); }
        sw.hitEnemies.add(u.id);
      }
    }
  }
}

function broccoliActive(side: Side): boolean {
  const u = broccoliUnits[side];
  return !!(u && u.state !== 'dead' && u.hp > 0);
}

function clearFoodEffects() {
  for (const p of foodProjectiles) if (p.mesh) scene.remove(p.mesh);
  for (const z of foodZones) {
    if (z.mesh) scene.remove(z.mesh);
    if (z.ringMesh) scene.remove(z.ringMesh);
  }
  for (const sw of coconutShockwaves) scene.remove(sw.ring);
  foodProjectiles.length = 0;
  foodZones.length = 0;
  coconutShockwaves.length = 0;
  broccoliUnits = { p1: null, p2: null };
}

function getMyBaseZ(side: Side): number {
  return side === 'p1' ? 0 : FIELD_LEN;
}
function getEnemyBaseZ(side: Side): number {
  return side === 'p1' ? FIELD_LEN : 0;
}
function forwardSign(side: Side): number {
  return side === 'p1' ? 1 : -1; // positive Z direction toward enemy
}

function findAllyClosestToBase(side: Side): UnitSim | null {
  const baseZ = getMyBaseZ(side);
  let best: UnitSim | null = null;
  let bestD = Infinity;
  for (const u of units) {
    if (u.side !== side || u.state === 'dead') continue;
    const d = Math.abs(u.z - baseZ);
    if (d < bestD) { bestD = d; best = u; }
  }
  return best;
}
function findAllyFarthestFromBase(side: Side): UnitSim | null {
  const baseZ = getMyBaseZ(side);
  let best: UnitSim | null = null;
  let bestD = -1;
  for (const u of units) {
    if (u.side !== side || u.state === 'dead') continue;
    const d = Math.abs(u.z - baseZ);
    if (d > bestD) { bestD = d; best = u; }
  }
  return best;
}
function findEnemyFarthestFromBase(side: Side): UnitSim | null {
  const baseZ = getMyBaseZ(side);
  let best: UnitSim | null = null;
  let bestD = -1;
  for (const u of units) {
    if (u.side === side || u.state === 'dead') continue;
    const d = Math.abs(u.z - baseZ);
    if (d > bestD) { bestD = d; best = u; }
  }
  return best;
}
function findEnemyClosestToBase(side: Side): UnitSim | null {
  const baseZ = getMyBaseZ(side);
  let best: UnitSim | null = null;
  let bestD = Infinity;
  for (const u of units) {
    if (u.side === side || u.state === 'dead') continue;
    const d = Math.abs(u.z - baseZ);
    if (d < bestD) { bestD = d; best = u; }
  }
  return best;
}
function pickEnemiesNear(side: Side, count: number, fromZ: number): UnitSim[] {
  const enemies = units.filter(u => u.side !== side && u.state !== 'dead');
  enemies.sort((a, b) => Math.abs(a.z - fromZ) - Math.abs(b.z - fromZ));
  return enemies.slice(0, count);
}
function pickAlliesRandom(side: Side, count: number): UnitSim[] {
  const allies = units.filter(u => u.side === side && u.state !== 'dead');
  // Fisher-Yates partial shuffle
  for (let i = 0; i < Math.min(count, allies.length); i++) {
    const j = i + Math.floor(Math.random() * (allies.length - i));
    [allies[i], allies[j]] = [allies[j], allies[i]];
  }
  return allies.slice(0, count);
}

function makeFoodProjMesh(foodId: string): THREE.Object3D {
  const mesh = makeFoodMesh(foodId);
  scene.add(mesh);
  return mesh;
}

// ─── Cast functions (one per food effect) ───────────────────────────────────
function castApple(side: Side, green: boolean) {
  const target = findAllyClosestToBase(side);
  const foodId = green ? 'apple_green' : 'apple';
  const baseZ = getMyBaseZ(side);
  const startPos = new THREE.Vector3(0, 5, baseZ);
  const mesh = makeFoodProjMesh(foodId);
  mesh.position.copy(startPos);
  foodProjectiles.push({
    food: foodId, effect: green ? 'green_apple_buff' : 'apple_buff',
    type: 'parabola_homing_ally', side, mesh,
    pos: startPos.clone(), vel: new THREE.Vector3(0, 6, forwardSign(side) * 8),
    done: false, age: 0, damage: 0, target,
    spinAxis: new THREE.Vector3(0, 1, 0), spinSpeed: 4,
  });
}
function castAvocado(side: Side) {
  const baseZ = getMyBaseZ(side);
  // Land at midfield for max value
  const targetZ = baseZ + forwardSign(side) * 12;
  const targetX = (Math.random() - 0.5) * 4;
  const startPos = new THREE.Vector3(0, 5, baseZ);
  const dx = targetX - 0;
  const dz = targetZ - baseZ;
  const tFlight = 1.4;
  const mesh = makeFoodProjMesh('avocado');
  mesh.position.copy(startPos);
  foodProjectiles.push({
    food: 'avocado', effect: 'avocado_slow', type: 'parabola_lob', side, mesh,
    pos: startPos.clone(),
    vel: new THREE.Vector3(dx / tFlight, 0.5 * 9.8 * tFlight, dz / tFlight),
    done: false, age: 0, damage: 0,
    spinAxis: new THREE.Vector3(1, 0, 1).normalize(), spinSpeed: 6,
  });
}
function castBanana(side: Side) {
  const target = findEnemyFarthestFromBase(side) ?? findEnemyClosestToBase(side);
  const baseZ = getMyBaseZ(side);
  const start = new THREE.Vector3(0, 3, baseZ);
  // Aim at target X/Z (no parabola — straight line, fast)
  const targetX = target ? target.x : 0;
  const targetZ = target ? target.z : baseZ + forwardSign(side) * 20;
  const dir = new THREE.Vector3(targetX - 0, 0, targetZ - baseZ).normalize();
  const speed = 30;
  const mesh = makeFoodProjMesh('banana');
  mesh.position.copy(start);
  foodProjectiles.push({
    food: 'banana', effect: 'banana_boomerang', type: 'banana', side, mesh,
    pos: start.clone(), vel: dir.multiplyScalar(speed),
    done: false, age: 0, damage: FOODS.banana.damage ?? 8,
    basePos: start.clone(), returnPhase: false, hitEnemies: new Set<string>(),
    spinAxis: new THREE.Vector3(1, 0, 0), spinSpeed: 18,
  });
}
function castCoconut(side: Side) {
  const def = FOODS.coconut;
  const enemies = units.filter(u => u.side !== side && u.state !== 'dead');
  // Find densest enemy cluster within 7-unit radius
  const CLUSTER_R = 7;
  let bestX = 0;
  let bestZ = (getMyBaseZ(side) + getEnemyBaseZ(side)) / 2;
  let bestCount = 0;
  if (enemies.length > 0) {
    for (const c of enemies) {
      let cnt = 0;
      for (const o of enemies) {
        const d = Math.sqrt((c.x - o.x) ** 2 + (c.z - o.z) ** 2);
        if (d < CLUSTER_R) cnt++;
      }
      if (cnt > bestCount) { bestCount = cnt; bestX = c.x; bestZ = c.z; }
    }
  }
  // Drop one very large coconut on densest cluster position
  const landX = bestX + (Math.random() - 0.5) * 1.0;
  const landZ = bestZ + (Math.random() - 0.5) * 1.0;
  const start = new THREE.Vector3(landX, 24, landZ);
  const mesh = makeFoodProjMesh('coconut');
  mesh.scale.multiplyScalar(4); // massive visual
  mesh.position.copy(start);
  foodProjectiles.push({
    food: 'coconut', effect: 'coconut_drop', type: 'mortar_drop', side, mesh,
    pos: start.clone(), vel: new THREE.Vector3(0, -18, 0),
    done: false, age: 0, damage: (def.damage ?? 12) * 2, aoe: 10,
    spinAxis: new THREE.Vector3(1, 0.3, 0).normalize(), spinSpeed: 12,
    splitOnLand: false,
  });
}
function castOrange(side: Side) {
  const def = FOODS.orange;
  const baseZ = getMyBaseZ(side);
  const enemyTargets = pickEnemiesNear(side, def.count, baseZ);
  const start = new THREE.Vector3(0, 4, baseZ);
  for (let i = 0; i < def.count; i++) {
    const target = enemyTargets[i] ?? enemyTargets[enemyTargets.length - 1] ?? null;
    const mesh = makeFoodProjMesh('orange');
    const offsetX = (Math.random() - 0.5) * 2;
    const sp = new THREE.Vector3(offsetX, start.y, baseZ);
    mesh.position.copy(sp);
    foodProjectiles.push({
      food: 'orange', effect: 'orange_volley', type: 'parabola_homing_enemy', side, mesh,
      pos: sp.clone(), vel: new THREE.Vector3((target ? target.x - offsetX : 0) * 0.5, 4, forwardSign(side) * 6),
      done: false, age: 0, damage: def.damage ?? 4, target,
      spinAxis: new THREE.Vector3(0, 1, 0), spinSpeed: 10,
    });
  }
}
function castPumpkin(side: Side) {
  const def = FOODS.pumpkin;
  const baseZ = getMyBaseZ(side);
  const maxDist = (FIELD_LEN / 2) - 2; // roll about 2/3 toward middle
  for (let i = 0; i < def.count; i++) {
    const offsetX = (i - (def.count - 1) / 2) * 2.5;
    const start = new THREE.Vector3(offsetX, 0.5, baseZ);
    const mesh = makeFoodProjMesh('pumpkin');
    mesh.position.copy(start);
    foodProjectiles.push({
      food: 'pumpkin', effect: 'pumpkin_roll', type: 'roll', side, mesh,
      pos: start.clone(), vel: new THREE.Vector3(0, 0, forwardSign(side) * 5),
      done: false, age: 0, damage: def.damage ?? 15,
      spinAxis: new THREE.Vector3(1, 0, 0), spinSpeed: 8,
      rollDistMax: maxDist, rollDistAcc: 0,
      hitEnemies: new Set<string>(),
    });
  }
}
function castTomato(side: Side) {
  const def = FOODS.tomato;
  const baseZ = getMyBaseZ(side);
  const enemyZ = getEnemyBaseZ(side);
  // Target ALL enemies within 5 units of enemy base (no count limit)
  const BASE_RANGE = 5;
  let targets = units.filter(u => u.side !== side && u.state !== 'dead' && Math.abs(u.z - enemyZ) <= BASE_RANGE);
  // Fallback: if no enemies near base, target all enemies
  if (targets.length === 0) targets = units.filter(u => u.side !== side && u.state !== 'dead');
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const offsetX = (Math.random() - 0.5) * 2;
    const startY = 3 + Math.random() * 2;
    const start = new THREE.Vector3(offsetX, startY, baseZ);
    const mesh = makeFoodProjMesh('tomato');
    mesh.position.copy(start);
    const delay = i * 100;
    const tx = target.x, tz = target.z;
    const dx = tx - start.x, dz = tz - start.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const tF = Math.max(0.9, dist / 12);
    setTimeout(() => {
      foodProjectiles.push({
        food: 'tomato', effect: 'tomato_lob', type: 'parabola_homing_enemy', side, mesh,
        pos: start.clone(),
        vel: new THREE.Vector3(dx / tF, 0.5 * 9.8 * tF, dz / tF),
        done: false, age: 0, damage: def.damage ?? 3,
        target,
        spinAxis: new THREE.Vector3(0, 1, 0), spinSpeed: 5,
      });
    }, delay);
  }
}
function castBroccoli(side: Side) {
  if (broccoliActive(side)) return;
  const farAlly = findAllyFarthestFromBase(side);
  const enemyZ = getEnemyBaseZ(side);
  let z: number;
  let x = (Math.random() - 0.5) * 4;
  if (farAlly) {
    z = farAlly.z;
    // Don't let it overlap enemy base
    if (Math.abs(z - enemyZ) < 5) z = enemyZ + forwardSign(side) * -5;
  } else {
    z = getMyBaseZ(side) + forwardSign(side) * 5;
  }
  // Spawn as a unit using a synthetic def
  const def = FOODS.broccoli;
  const id = `broccoli_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  const mesh = makeFoodMesh('broccoli');
  mesh.position.set(x, def.size, z);
  scene.add(mesh);
  // Inject ad-hoc AnimalDef so other code paths work
  const adHocDef: AnimalDef = {
    id: 'broccoli_barrier', name: '브로콜리', layer: 'ground', attackLayer: 'ground',
    hp: 30, atk: 0, spd: 0, atkCooldown: 99, range: 0, cost: 0,
    size: def.size, color: def.color,
  };
  if (!ANIMALS['broccoli_barrier']) ANIMALS['broccoli_barrier'] = adHocDef;
  const unit: UnitSim = {
    id, animalId: 'broccoli_barrier', side, z, x,
    hp: 30, maxHp: 30, state: 'attacking',
    atkTimer: 0, mesh, hpSprite: null, dustMesh: null, lastHp: 30,
    mixer: null, currentAnim: '',
  };
  units.push(unit);
  broccoliUnits[side] = unit;
  // Auto-despawn after duration
  const expireAt = battleClock + (def.duration ?? 5);
  (unit as any)._broccoliExpire = expireAt;
}
function castCarrot(side: Side) {
  const def = FOODS.carrot;
  const baseZ = getMyBaseZ(side);
  // Part 1: Dense carpet of carrot spikes near own base — enemies anywhere in
  // the base zone will be hit
  const ZONE_COUNT = 18;
  const ZONE_DEPTH = 9;
  const ZONE_WIDTH = 11;
  for (let i = 0; i < ZONE_COUNT; i++) {
    const x = (Math.random() - 0.5) * ZONE_WIDTH;
    const z = baseZ + forwardSign(side) * (0.5 + Math.random() * ZONE_DEPTH);
    const mesh = makeFoodMesh('carrot');
    mesh.rotation.x = Math.PI;
    mesh.position.set(x, def.size, z);
    scene.add(mesh);
    foodZones.push({
      food: 'carrot', type: 'carrot_spike', side, mesh,
      pos: new THREE.Vector3(x, 0, z),
      radius: 1.4, // large hitbox
      endTime: battleClock + (def.duration ?? 3),
      damageOnContact: def.damage ?? 5,
    });
  }
  // (체인 당근 없음 — 기지 앞 구역 스파이크만)
}
function castEggplant(side: Side) {
  const target = findEnemyClosestToBase(side);
  const baseZ = getMyBaseZ(side);
  const targetX = target ? target.x : 0;
  const targetZ = target ? target.z : baseZ + forwardSign(side) * 8;
  const start = new THREE.Vector3(0, 4, baseZ);
  const dx = targetX, dz = targetZ - baseZ;
  const tFlight = 1.0;
  const mesh = makeFoodProjMesh('eggplant');
  mesh.position.copy(start);
  foodProjectiles.push({
    food: 'eggplant', effect: 'eggplant_dot', type: 'parabola_lob', side, mesh,
    pos: start.clone(), vel: new THREE.Vector3(dx / tFlight, 0.5 * 9.8 * tFlight, dz / tFlight),
    done: false, age: 0, damage: 0,
    spinAxis: new THREE.Vector3(1, 0, 0), spinSpeed: 6,
    zoneOnLand: 'eggplant_dot', aoe: FOODS.eggplant.aoe ?? 3,
  });
}
function castLettuce(side: Side) {
  const def = FOODS.lettuce;
  const MAX_LETTUCE = 6;
  const enemies = units.filter(u => u.side !== side && u.state !== 'dead');
  const spawnTargets = enemies.length > 0
    ? enemies.slice(0, MAX_LETTUCE)
    : null;
  if (spawnTargets && spawnTargets.length > 0) {
    // Spawn one lettuce mine at each enemy's current position
    for (const e of spawnTargets) {
      const ox = (Math.random() - 0.5) * 0.8;
      const oz = (Math.random() - 0.5) * 0.8;
      const x = e.x + ox, z = e.z + oz;
      const mesh = makeFoodMesh('lettuce');
      mesh.position.set(x, def.size, z);
      scene.add(mesh);
      foodZones.push({
        food: 'lettuce', type: 'lettuce_mine', side, mesh,
        pos: new THREE.Vector3(x, 0, z), radius: def.aoe ?? 2,
        endTime: battleClock + (def.duration ?? 5),
        damageOnContact: def.damage ?? 12,
      });
    }
  } else {
    // No enemies: scatter near enemy base
    const enemyZ = getEnemyBaseZ(side);
    for (let i = 0; i < 3; i++) {
      const x = (Math.random() - 0.5) * 7;
      const z = enemyZ + forwardSign(side) * -(1 + Math.random() * 4);
      const mesh = makeFoodMesh('lettuce');
      mesh.position.set(x, def.size, z);
      scene.add(mesh);
      foodZones.push({
        food: 'lettuce', type: 'lettuce_mine', side, mesh,
        pos: new THREE.Vector3(x, 0, z), radius: def.aoe ?? 2,
        endTime: battleClock + (def.duration ?? 5),
        damageOnContact: def.damage ?? 12,
      });
    }
  }
}
function castMushroom(side: Side) {
  const def = FOODS.mushroom;
  const MAX_MUSHROOM = 8;
  const enemies = units.filter(u => u.side !== side && u.state !== 'dead');
  const spawnTargets = enemies.length > 0
    ? enemies.slice(0, MAX_MUSHROOM)
    : null;
  if (spawnTargets && spawnTargets.length > 0) {
    // Spawn one mushroom directly at each enemy's current position
    for (const e of spawnTargets) {
      const ox = (Math.random() - 0.5) * 0.6;
      const oz = (Math.random() - 0.5) * 0.6;
      const x = e.x + ox, z = e.z + oz;
      const mesh = makeFoodMesh('mushroom');
      mesh.position.set(x, def.size, z);
      scene.add(mesh);
      foodZones.push({
        food: 'mushroom', type: 'mushroom_paralyze', side, mesh,
        pos: new THREE.Vector3(x, 0, z), radius: 1.0,
        endTime: battleClock + 20,
        paralyzeDuration: def.duration ?? 2,
      });
    }
  } else {
    // No enemies: scatter across the field near enemy side
    const enemyZ = getEnemyBaseZ(side);
    for (let i = 0; i < 4; i++) {
      const x = (Math.random() - 0.5) * 9;
      const z = enemyZ + forwardSign(side) * -(2 + Math.random() * 8);
      const mesh = makeFoodMesh('mushroom');
      mesh.position.set(x, def.size, z);
      scene.add(mesh);
      foodZones.push({
        food: 'mushroom', type: 'mushroom_paralyze', side, mesh,
        pos: new THREE.Vector3(x, 0, z), radius: 1.0,
        endTime: battleClock + 20,
        paralyzeDuration: def.duration ?? 2,
      });
    }
  }
}
function castPepperGreen(side: Side) {
  const def = FOODS.pepper_green;
  const targets = pickAlliesRandom(side, def.count);
  const baseZ = getMyBaseZ(side);
  const start = new THREE.Vector3(0, 4, baseZ);
  for (const target of targets) {
    const mesh = makeFoodProjMesh('pepper_green');
    mesh.position.copy(start);
    foodProjectiles.push({
      food: 'pepper_green', effect: 'pepper_green_heal', type: 'parabola_homing_ally',
      side, mesh, pos: start.clone(),
      vel: new THREE.Vector3((target.x - 0) * 0.7, 5, (target.z - baseZ) * 0.5),
      done: false, age: 0, damage: 0, target,
      spinAxis: new THREE.Vector3(0, 1, 0), spinSpeed: 8,
    });
  }
}
function castPepperRed(side: Side) {
  const def = FOODS.pepper_red;
  const baseZ = getMyBaseZ(side);
  const enemies = pickEnemiesNear(side, def.count, baseZ);
  const start = new THREE.Vector3(0, 4, baseZ);
  for (const target of enemies) {
    const mesh = makeFoodProjMesh('pepper_red');
    mesh.position.copy(start);
    foodProjectiles.push({
      food: 'pepper_red', effect: 'pepper_red_dot', type: 'parabola_homing_enemy',
      side, mesh, pos: start.clone(),
      vel: new THREE.Vector3((target.x - 0) * 0.7, 5, (target.z - baseZ) * 0.5),
      done: false, age: 0, damage: 0, target,
      spinAxis: new THREE.Vector3(0, 1, 0), spinSpeed: 8,
    });
  }
}
function castTurnip(side: Side) {
  const def = FOODS.turnip;
  const enemies = pickEnemiesNear(side, def.count, getEnemyBaseZ(side));
  for (let i = 0; i < def.count; i++) {
    const target = enemies[i];
    const x = target ? target.x : (Math.random() - 0.5) * 8;
    const z = target ? target.z : getEnemyBaseZ(side) + forwardSign(side) * (8 + i * 3);
    const start = new THREE.Vector3(x, -0.3, z);
    const mesh = makeFoodProjMesh('turnip');
    mesh.position.copy(start);
    foodProjectiles.push({
      food: 'turnip', effect: 'turnip_uppercut', type: 'turnip', side, mesh,
      pos: start.clone(), vel: new THREE.Vector3(0, 0, 0),
      done: false, age: 0, damage: def.damage ?? 8,
      hitEnemies: new Set<string>(),
      hitEnemies2: new Set<string>(),
      turnipPhase: 'up' as 'up' | 'down',
    });
  }
}
function castEgg(side: Side) {
  const def = FOODS.egg;
  const baseZ = getMyBaseZ(side);
  const enemies = pickEnemiesNear(side, def.count, baseZ);
  for (let i = 0; i < def.count; i++) {
    const target = enemies[i] ?? null;
    const offsetX = (Math.random() - 0.5) * 3;
    const start = new THREE.Vector3(offsetX, 3, baseZ);
    const tx = target ? target.x : offsetX;
    const tz = target ? target.z : baseZ + forwardSign(side) * (8 + i * 3);
    const dx = tx - offsetX, dz = tz - baseZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const tF = Math.max(0.8, dist / 12);
    const mesh = makeFoodProjMesh('egg');
    mesh.position.copy(start);
    // Parabola + homing: gravity applied in movement, horizontal steering toward target
    foodProjectiles.push({
      food: 'egg', effect: 'egg_drop', type: 'parabola_homing_enemy', side, mesh,
      pos: start.clone(),
      vel: new THREE.Vector3(dx / tF, 0.5 * 9.8 * tF, dz / tF),
      done: false, age: 0, damage: def.damage ?? 3,
      target,
      spawnChickOnImpact: true,
      // no spinAxis/spinSpeed → no tumbling
    });
  }
}

function triggerFoodEffect(foodId: string, side: Side) {
  switch (foodId) {
    case 'apple':       castApple(side, false); break;
    case 'apple_green': castApple(side, true); break;
    case 'avocado':     castAvocado(side); break;
    case 'banana':      castBanana(side); break;
    case 'coconut':     castCoconut(side); break;
    case 'orange':      castOrange(side); break;
    case 'pumpkin':     castPumpkin(side); break;
    case 'tomato':      castTomato(side); break;
    case 'broccoli':    castBroccoli(side); break;
    case 'carrot':      castCarrot(side); break;
    case 'eggplant':    castEggplant(side); break;
    case 'lettuce':     castLettuce(side); break;
    case 'mushroom':    castMushroom(side); break;
    case 'pepper_green': castPepperGreen(side); break;
    case 'pepper_red':   castPepperRed(side); break;
    case 'turnip':      castTurnip(side); break;
    case 'egg':         castEgg(side); break;
  }
}

// ─── Step functions ──────────────────────────────────────────────────────────
function applyAppleBuff(u: UnitSim, green: boolean) {
  if (green) {
    if (u.greenAppleBuffed) return;
    u.greenAppleBuffed = true;
    u.maxHp *= 2;
    u.hp = Math.min(u.maxHp, u.hp * 2);
  } else {
    if (u.appleBuffed) return;
    u.appleBuffed = true;
  }
  u.visualScale = (u.visualScale ?? 1) * 2;
  if (u.mesh) {
    const cur = u.mesh.scale.x;
    u.mesh.scale.setScalar(cur * 2);
  }
}

function stepFoodProjectiles(dt: number) {
  for (const p of foodProjectiles) {
    if (p.done) continue;
    p.age += dt;
    // Spin visual
    if (p.mesh && p.spinAxis && p.spinSpeed) {
      p.mesh.rotateOnAxis(p.spinAxis, p.spinSpeed * dt);
    }
    // Movement
    switch (p.type) {
      case 'parabola_lob':
      case 'parabola_homing_enemy':
      case 'parabola_homing_ally':
      case 'mortar_drop': {
        // Simple gravity
        p.vel.y -= 9.8 * dt;
        // Light homing for homing variants (steer toward target)
        if (p.target && (p.type === 'parabola_homing_ally' || p.type === 'parabola_homing_enemy')) {
          if (p.target.state === 'dead') p.target = null;
          if (p.target) {
            const dx = p.target.x - p.pos.x;
            const dz = p.target.z - p.pos.z;
            const d = Math.sqrt(dx*dx + dz*dz);
            if (d > 0.01) {
              const k = 6 * dt;
              p.vel.x += (dx / d) * k * 4;
              p.vel.z += (dz / d) * k * 4;
            }
          }
        }
        p.pos.addScaledVector(p.vel, dt);
        if (p.mesh) p.mesh.position.copy(p.pos);
        break;
      }
      case 'banana': {
        p.pos.addScaledVector(p.vel, dt);
        if (p.mesh) p.mesh.position.copy(p.pos);
        break;
      }
      case 'roll': {
        p.pos.addScaledVector(p.vel, dt);
        p.pos.y = (FOODS.pumpkin.size ?? 0.5);
        if (p.mesh) p.mesh.position.copy(p.pos);
        p.rollDistAcc = (p.rollDistAcc ?? 0) + Math.abs(p.vel.z) * dt;
        if (p.rollDistAcc >= (p.rollDistMax ?? 12)) p.done = true;
        break;
      }
      case 'turnip': {
        const RISE_SPEED = 7;
        const FALL_SPEED = 6;
        const MAX_HEIGHT = 3.5;
        if (p.turnipPhase === 'up') {
          p.pos.y += RISE_SPEED * dt;
          if (p.pos.y >= MAX_HEIGHT) { p.pos.y = MAX_HEIGHT; p.turnipPhase = 'down'; }
        } else {
          p.pos.y -= FALL_SPEED * dt;
          if (p.pos.y <= -0.4) { p.done = true; p.pos.y = -0.4; }
        }
        if (p.mesh) p.mesh.position.copy(p.pos);
        // Damage check: hit enemies within radius 1.2 horizontally
        const hitSet = p.turnipPhase === 'up' ? p.hitEnemies! : (p.hitEnemies2 ?? (p.hitEnemies2 = new Set()));
        for (const u of units) {
          if (u.side === p.side || u.state === 'dead' || hitSet.has(u.id)) continue;
          const dx = u.x - p.pos.x, dz = u.z - p.pos.z;
          if (Math.sqrt(dx*dx + dz*dz) < 1.2) {
            hitSet.add(u.id);
            u.hp = Math.max(0, u.hp - p.damage);
            if (u.hp <= 0) u.state = 'dead';
            sfx('food_hit');
          }
        }
        break;
      }
      case 'homing_missile': {
        // Retarget if current target died
        if (p.target && p.target.state === 'dead') {
          let nearest: UnitSim | null = null;
          let nearestD = Infinity;
          for (const u of units) {
            if (u.side === p.side || u.state === 'dead') continue;
            const d = Math.sqrt((p.pos.x - u.x) ** 2 + (p.pos.z - u.z) ** 2);
            if (d < nearestD) { nearestD = d; nearest = u; }
          }
          p.target = nearest;
        }
        if (p.target) {
          const tx = p.target.x;
          const ty = (p.target.mesh?.position.y ?? 0) + 0.5;
          const tz = p.target.z;
          const dx = tx - p.pos.x, dy = ty - p.pos.y, dz = tz - p.pos.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const speed = 14;
          if (d > 0.1) {
            const want = new THREE.Vector3(dx / d * speed, dy / d * speed, dz / d * speed);
            p.vel.lerp(want, Math.min(dt * 6, 1));
          }
        }
        p.pos.addScaledVector(p.vel, dt);
        if (p.mesh) p.mesh.position.copy(p.pos);
        break;
      }
      case 'carrot_chain': {
        // Parabolic arc with horizontal homing toward current target
        p.vel.y -= 9.8 * dt;
        if (p.target && p.target.state !== 'dead') {
          const dx = p.target.x - p.pos.x;
          const dz = p.target.z - p.pos.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > 0.01) {
            p.vel.x += (dx / d) * 28 * dt; // strong horizontal homing
            p.vel.z += (dz / d) * 28 * dt;
          }
        }
        p.pos.addScaledVector(p.vel, dt);
        if (p.mesh) p.mesh.position.copy(p.pos);
        break;
      }
    }

    // Collision logic per effect
    if (p.done) continue;

    // ── homing_missile: proximity hit ─────────────────────────────────────────
    if (p.type === 'homing_missile') {
      if (p.target && p.target.state !== 'dead') {
        const d = Math.sqrt((p.pos.x - p.target.x) ** 2 + (p.pos.z - p.target.z) ** 2);
        if (d < 1.0) {
          p.target.hp = Math.max(0, p.target.hp - p.damage);
          if (p.target.hp <= 0) p.target.state = 'dead';
          if (p.spawnChickOnImpact && Math.random() < 0.5) {
            spawnUnit('chick', p.side, undefined, p.pos.x, p.pos.z);
          }
          spawnParticles(p.pos.clone(), 0xffdd44, 6, 3, 0.3);
          sfx('food_hit'); p.done = true;
        }
      } else if (!p.target) {
        p.done = true;
      }
      if (p.age > 10) p.done = true;
      continue;
    }

    // ── carrot_chain: parabola hit + chain relaunch ───────────────────────────
    if (p.type === 'carrot_chain') {
      // Retarget if dead
      if (p.target && p.target.state === 'dead') p.target = null;

      let hitTarget = false;
      if (p.target) {
        const d = Math.sqrt((p.pos.x - p.target.x) ** 2 + (p.pos.z - p.target.z) ** 2);
        if (d < 1.1) hitTarget = true;
      }
      // Also chain when hitting the ground (missed target)
      const groundHit = p.pos.y < 0 && p.age > 0.3;

      if (hitTarget || groundHit) {
        if (hitTarget && p.target) {
          p.target.hp = Math.max(0, p.target.hp - p.damage);
          if (p.target.hp <= 0) p.target.state = 'dead';
          p.chainHitEnemies?.add(p.target.id);
          sfx('food_hit');
        }
        // Find next unhit enemy
        let next: UnitSim | null = null;
        let nextD = Infinity;
        for (const u of units) {
          if (u.side === p.side || u.state === 'dead') continue;
          if (p.chainHitEnemies?.has(u.id)) continue;
          const du = Math.sqrt((p.pos.x - u.x) ** 2 + (p.pos.z - u.z) ** 2);
          if (du < nextD) { nextD = du; next = u; }
        }
        if (next) {
          p.target = next;
          // Relaunch from current position with a fresh parabola arc
          p.pos.y = Math.max(p.pos.y, 0.3);
          const ddx = next.x - p.pos.x, ddz = next.z - p.pos.z;
          const dist2 = Math.sqrt(ddx * ddx + ddz * ddz);
          const tF2 = Math.max(0.6, dist2 / 14);
          p.vel.set(ddx / tF2, 0.5 * 9.8 * tF2, ddz / tF2);
        } else {
          p.done = true; // all enemies hit
        }
      }
      if (p.age > 25) p.done = true;
      continue;
    }

    if (p.effect === 'apple_buff' || p.effect === 'green_apple_buff') {
      // Reach target ally → apply buff
      if (p.target && p.target.state !== 'dead') {
        const d = Math.sqrt((p.pos.x - p.target.x)**2 + (p.pos.z - p.target.z)**2);
        if (d < 1.0) {
          applyAppleBuff(p.target, p.effect === 'green_apple_buff');
          p.done = true;
        }
      } else if (!p.target || p.pos.y < -2) {
        p.done = true;
      }
      continue;
    }

    if (p.effect === 'pepper_green_heal') {
      if (p.target && p.target.state !== 'dead') {
        const d = Math.sqrt((p.pos.x - p.target.x)**2 + (p.pos.z - p.target.z)**2);
        if (d < 1.0) {
          p.target.hotEndTime = battleClock + (FOODS.pepper_green.duration ?? 3);
          p.target.hotPerSec = 10;
          p.target.hotNextTick = battleClock + 1;
          p.done = true;
        }
      } else if (!p.target || p.pos.y < -2) p.done = true;
      continue;
    }

    if (p.effect === 'pepper_red_dot') {
      if (p.target && p.target.state !== 'dead') {
        const d = Math.sqrt((p.pos.x - p.target.x)**2 + (p.pos.z - p.target.z)**2);
        if (d < 1.0) {
          p.target.dotEndTime = battleClock + (FOODS.pepper_red.duration ?? 3);
          p.target.dotPerSec = 10;
          p.target.dotNextTick = battleClock + 1;
          p.done = true;
        }
      } else if (!p.target || p.pos.y < -2) p.done = true;
      continue;
    }

    if (p.effect === 'orange_volley') {
      // Hit enemy on contact OR ground
      const enemies = units.filter(e => e.side !== p.side && e.state !== 'dead' && e.state !== 'underground');
      let hit = false;
      for (const e of enemies) {
        const ed = Math.sqrt((p.pos.x - e.x)**2 + (p.pos.z - e.z)**2);
        if (ed < (ANIMALS[e.animalId]?.size ?? 0.4) + 0.4) {
          e.hp = Math.max(0, e.hp - p.damage);
          if (e.hp <= 0) e.state = 'dead';
          hit = true;
          break;
        }
      }
      if (hit || p.pos.y < 0) { sfx('food_hit'); p.done = true; }
      continue;
    }

    if (p.effect === 'tomato_lob') {
      // Primary: proximity hit on target (homing)
      if (p.target && p.target.state !== 'dead') {
        const d = Math.sqrt((p.pos.x - p.target.x) ** 2 + (p.pos.z - p.target.z) ** 2);
        if (d < 1.1) {
          p.target.hp = Math.max(0, p.target.hp - p.damage);
          if (p.target.hp <= 0) p.target.state = 'dead';
          // Tomato: knockback + slow
          const kbSign = p.target.side === 'p1' ? -1 : 1;
          p.target.z = Math.max(0, Math.min(FIELD_LEN, p.target.z + kbSign * 1.5));
          if (p.target.mesh) p.target.mesh.position.z = p.target.z;
          p.target.slowUntil = battleClock + 1.5;
          p.target.slowFactor = 0.5;
          sfx('food_hit'); p.done = true;
        }
      }
      // Fallback: ground impact (target died before we reached it)
      if (!p.done && p.pos.y < 0) {
        const enemies = units.filter(e => e.side !== p.side && e.state !== 'dead');
        for (const e of enemies) {
          const ed = Math.sqrt((p.pos.x - e.x) ** 2 + (p.pos.z - e.z) ** 2);
          if (ed < 1.4) {
            e.hp = Math.max(0, e.hp - p.damage); if (e.hp <= 0) e.state = 'dead';
            // Tomato: knockback + slow on ground hit
            const kbSign2 = e.side === 'p1' ? -1 : 1;
            e.z = Math.max(0, Math.min(FIELD_LEN, e.z + kbSign2 * 1.5));
            if (e.mesh) e.mesh.position.z = e.z;
            e.slowUntil = battleClock + 1.5;
            e.slowFactor = 0.5;
          }
        }
        sfx('food_hit'); p.done = true;
      }
      if (p.age > 8) p.done = true;
      continue;
    }

    if (p.effect === 'coconut_drop') {
      if (p.pos.y <= 0.2) {
        p.pos.y = 0;
        // Expanding shockwave ring (AOE damage as ring expands)
        triggerCoconutShockwave(p.pos.x, p.pos.z, p.side, p.damage, p.aoe ?? 10);
        // Split-halves visual — same enlarged scale as the projectile
        if (p.mesh) scene.remove(p.mesh);
        const halfL = makeFoodMesh('coconut_half');
        const halfR = makeFoodMesh('coconut_half');
        const bigScale = (foodModelScales['coconut'] ?? 1) * 4;
        halfL.scale.setScalar(bigScale);
        halfR.scale.setScalar(bigScale);
        halfL.position.set(p.pos.x - 1.0, FOODS.coconut.size * 2, p.pos.z);
        halfR.position.set(p.pos.x + 1.0, FOODS.coconut.size * 2, p.pos.z);
        halfR.rotation.y = Math.PI;
        scene.add(halfL); scene.add(halfR);
        setTimeout(() => { scene.remove(halfL); scene.remove(halfR); }, 700);
        p.mesh = null;
        p.done = true;
      }
      continue;
    }

    if (p.effect === 'banana_boomerang') {
      if (!p.returnPhase) {
        // Chain phase: hit enemies one by one and redirect
        const enemies = units.filter(e => e.side !== p.side && e.state !== 'dead');
        for (const e of enemies) {
          if (p.hitEnemies?.has(e.id)) continue;
          const ed = Math.sqrt((p.pos.x - e.x) ** 2 + (p.pos.z - e.z) ** 2);
          if (ed < (ANIMALS[e.animalId]?.size ?? 0.4) + 0.5) {
            e.hp = Math.max(0, e.hp - p.damage);
            if (e.hp <= 0) e.state = 'dead';
            p.hitEnemies?.add(e.id);
            // Find next unhit enemy closest to current position
            let next: UnitSim | null = null;
            let nextD = Infinity;
            for (const u of units) {
              if (u.side === p.side || u.state === 'dead') continue;
              if (p.hitEnemies?.has(u.id)) continue;
              const du = Math.sqrt((p.pos.x - u.x) ** 2 + (p.pos.z - u.z) ** 2);
              if (du < nextD) { nextD = du; next = u; }
            }
            if (next) {
              // Redirect toward next enemy at same speed
              const spd = Math.sqrt(p.vel.x ** 2 + p.vel.z ** 2);
              const dx = next.x - p.pos.x, dz = next.z - p.pos.z;
              const d = Math.sqrt(dx * dx + dz * dz);
              if (d > 0.01) { p.vel.x = (dx / d) * spd; p.vel.z = (dz / d) * spd; }
            } else {
              // All enemies hit — return to base
              p.returnPhase = true;
              const bx = p.basePos?.x ?? 0, bz = p.basePos?.z ?? p.pos.z;
              const spd = Math.sqrt(p.vel.x ** 2 + p.vel.z ** 2);
              const dx = bx - p.pos.x, dz = bz - p.pos.z;
              const d = Math.sqrt(dx * dx + dz * dz);
              if (d > 0.01) { p.vel.x = (dx / d) * spd; p.vel.z = (dz / d) * spd; }
            }
            break; // one redirect per frame
          }
        }
        // Fallback: if no enemies exist at all, return to base
        if (!p.returnPhase && enemies.length === 0) {
          p.returnPhase = true;
          const bx = p.basePos?.x ?? 0, bz = p.basePos?.z ?? p.pos.z;
          const spd = Math.sqrt(p.vel.x ** 2 + p.vel.z ** 2);
          const dx = bx - p.pos.x, dz = bz - p.pos.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > 0.01) { p.vel.x = (dx / d) * spd; p.vel.z = (dz / d) * spd; }
        }
      } else {
        // Return phase: fly back to base, no more hits
        if (p.basePos) {
          const db = Math.sqrt((p.pos.x - p.basePos.x) ** 2 + (p.pos.z - p.basePos.z) ** 2);
          if (db < 1.5) p.done = true;
        }
      }
      if (p.age > 30) p.done = true;
      continue;
    }

    if (p.effect === 'pumpkin_roll') {
      const enemies = units.filter(e => e.side !== p.side && e.state !== 'dead' && ANIMALS[e.animalId]?.layer !== 'air');
      for (const e of enemies) {
        if (p.hitEnemies?.has(e.id)) continue;
        const ed = Math.sqrt((p.pos.x - e.x)**2 + (p.pos.z - e.z)**2);
        if (ed < (ANIMALS[e.animalId]?.size ?? 0.4) + 0.7) {
          e.hp = Math.max(0, e.hp - p.damage);
          if (e.hp <= 0) e.state = 'dead';
          p.hitEnemies?.add(e.id);
        }
      }
      continue;
    }

    if (p.effect === 'eggplant_dot') {
      if (p.pos.y < 0) {
        // Spawn DOT zone
        p.pos.y = 0;
        const radius = p.aoe ?? 3;
        const ring = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 28),
          new THREE.MeshBasicMaterial({ color: 0x6a0dad, transparent: true, opacity: 0.45, depthWrite: false })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.pos.x, 0.02, p.pos.z);
        scene.add(ring);
        foodZones.push({
          food: 'eggplant', type: 'eggplant_dot', side: p.side, mesh: ring,
          pos: new THREE.Vector3(p.pos.x, 0, p.pos.z), radius,
          endTime: battleClock + (FOODS.eggplant.duration ?? 5),
          damagePerSec: 5,
        });
        p.done = true;
      }
      continue;
    }

    if (p.effect === 'avocado_slow') {
      if (p.pos.y < 0) {
        p.pos.y = 0;
        const radius = FOODS.avocado.aoe ?? 4;
        const ring = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 28),
          new THREE.MeshBasicMaterial({ color: 0x6c8c40, transparent: true, opacity: 0.40, depthWrite: false })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.pos.x, 0.02, p.pos.z);
        scene.add(ring);
        // Pit visual: leave a mini avocado mesh
        const pit = makeFoodMesh('avocado');
        pit.position.set(p.pos.x, FOODS.avocado.size, p.pos.z);
        scene.add(pit);
        foodZones.push({
          food: 'avocado', type: 'avocado_slow', side: p.side, mesh: pit, ringMesh: ring,
          pos: new THREE.Vector3(p.pos.x, 0, p.pos.z), radius,
          endTime: battleClock + (FOODS.avocado.duration ?? 5),
          slowFactor: 0.4,
        });
        p.done = true;
      }
      continue;
    }

    // turnip_uppercut damage is now handled inline in the 'turnip' case above
    if (p.effect === 'turnip_uppercut') {
      continue;
    }

    if (p.effect === 'egg_drop') {
      // Primary: proximity hit on homing target
      if (p.target && p.target.state !== 'dead') {
        const d = Math.sqrt((p.pos.x - p.target.x) ** 2 + (p.pos.z - p.target.z) ** 2);
        if (d < 1.0) {
          p.target.hp = Math.max(0, p.target.hp - p.damage);
          if (p.target.hp <= 0) p.target.state = 'dead';
          if (p.spawnChickOnImpact && Math.random() < 0.5) {
            spawnUnit('chick', p.side, undefined, p.pos.x, p.pos.z);
          }
          sfx('food_hit'); p.done = true;
        }
      }
      // Fallback: ground impact
      if (!p.done && p.pos.y <= 0.2) {
        if (p.spawnChickOnImpact && Math.random() < 0.5) {
          spawnUnit('chick', p.side, undefined, p.pos.x, p.pos.z);
        }
        sfx('food_hit'); p.done = true;
      }
      if (p.age > 8) p.done = true;
      continue;
    }
  }

  // Cleanup
  for (let i = foodProjectiles.length - 1; i >= 0; i--) {
    if (foodProjectiles[i].done) {
      const m = foodProjectiles[i].mesh;
      if (m) scene.remove(m);
      foodProjectiles.splice(i, 1);
    }
  }
}

function stepFoodZones(dt: number) {
  const now = battleClock;
  for (const z of foodZones) {
    // Visual age fade for ring meshes
    if (z.ringMesh) {
      const remain = z.endTime - now;
      const ringMat = z.ringMesh.material as THREE.MeshBasicMaterial;
      if (remain < 1) ringMat.opacity = Math.max(0, remain * 0.4);
    }
    if (z.used || now > z.endTime) continue;
    const enemies = units.filter(e => e.side !== z.side && e.state !== 'dead' && ANIMALS[e.animalId]?.layer !== 'air');

    if (z.type === 'avocado_slow') {
      for (const e of enemies) {
        const d = Math.sqrt((z.pos.x - e.x)**2 + (z.pos.z - e.z)**2);
        if (d < z.radius) {
          e.slowedUntil = now + 0.05; // refreshed every frame while inside
          e.slowFactor = z.slowFactor ?? 0.4;
        }
      }
    } else if (z.type === 'eggplant_dot') {
      for (const e of enemies) {
        const d = Math.sqrt((z.pos.x - e.x)**2 + (z.pos.z - e.z)**2);
        if (d < z.radius) {
          e.hp = Math.max(0, e.hp - (z.damagePerSec ?? 5) * dt);
          if (e.hp <= 0) e.state = 'dead';
        }
      }
    } else if (z.type === 'lettuce_mine') {
      for (const e of enemies) {
        const d = Math.sqrt((z.pos.x - e.x)**2 + (z.pos.z - e.z)**2);
        if (d < 0.8) {
          // Explode: AOE damage
          for (const e2 of enemies) {
            const d2 = Math.sqrt((z.pos.x - e2.x)**2 + (z.pos.z - e2.z)**2);
            if (d2 < (z.radius ?? 2)) {
              e2.hp = Math.max(0, e2.hp - (z.damageOnContact ?? 12));
              if (e2.hp <= 0) e2.state = 'dead';
            }
          }
          z.used = true;
          break;
        }
      }
    } else if (z.type === 'carrot_spike') {
      for (const e of enemies) {
        const d = Math.sqrt((z.pos.x - e.x)**2 + (z.pos.z - e.z)**2);
        if (d < (z.radius ?? 0.6)) {
          // Once-per-second per spike (use ageInjected as last-hit timer)
          const lastHit = z.ageInjected ?? -1;
          if (now - lastHit > 0.5) {
            e.hp = Math.max(0, e.hp - (z.damageOnContact ?? 5));
            if (e.hp <= 0) e.state = 'dead';
            z.ageInjected = now;
          }
        }
      }
    } else if (z.type === 'mushroom_paralyze') {
      for (const e of enemies) {
        const d = Math.sqrt((z.pos.x - e.x)**2 + (z.pos.z - e.z)**2);
        if (d < (z.radius ?? 0.7)) {
          e.paralyzedUntil = now + (z.paralyzeDuration ?? 2);
          z.used = true;
          break;
        }
      }
    }
  }

  // Cleanup expired/used
  for (let i = foodZones.length - 1; i >= 0; i--) {
    const z = foodZones[i];
    if (z.used || now > z.endTime) {
      if (z.mesh) scene.remove(z.mesh);
      if (z.ringMesh) scene.remove(z.ringMesh);
      foodZones.splice(i, 1);
    }
  }
}

function stepFoodBuffs(_dt: number) {
  const now = battleClock;
  for (const u of units) {
    // Heal-over-time (pepper_green)
    if (u.hotEndTime && now < u.hotEndTime) {
      if (u.hotNextTick && now >= u.hotNextTick) {
        u.hp = Math.min(u.maxHp, u.hp + (u.hotPerSec ?? 10));
        u.hotNextTick = (u.hotNextTick ?? now) + 1;
      }
    } else if (u.hotEndTime) {
      u.hotEndTime = undefined;
    }
    // Damage-over-time (pepper_red)
    if (u.dotEndTime && now < u.dotEndTime && u.state !== 'dead') {
      if (u.dotNextTick && now >= u.dotNextTick) {
        u.hp = Math.max(0, u.hp - (u.dotPerSec ?? 10));
        if (u.hp <= 0) u.state = 'dead';
        u.dotNextTick = (u.dotNextTick ?? now) + 1;
      }
    } else if (u.dotEndTime) {
      u.dotEndTime = undefined;
    }
  }
  // Broccoli auto-despawn
  for (const side of ['p1','p2'] as Side[]) {
    const u = broccoliUnits[side];
    if (u && (u as any)._broccoliExpire && now > (u as any)._broccoliExpire) {
      u.state = 'dead';
      u.hp = 0;
      broccoliUnits[side] = null;
    }
  }
}

function updateSiegeButtons() {
  const myBallista = localSide === 'p1' ? p1Ballista : p2Ballista;
  const myCatapult = localSide === 'p1' ? p1Catapult : p2Catapult;
  const btnB = $('btn-ballista') as HTMLButtonElement;
  const btnC = $('btn-catapult') as HTMLButtonElement;
  if (!btnB || !btnC) return;
  if (myBallista) {
    btnB.textContent = '발리스타 ✓';
    btnB.style.opacity = '0.5'; btnB.style.cursor = 'not-allowed';
  } else {
    btnB.textContent = `발리스타 (${SIEGE_COST})`;
    btnB.style.opacity = currency >= SIEGE_COST ? '1' : '0.4';
    btnB.style.cursor = currency >= SIEGE_COST ? 'pointer' : 'not-allowed';
  }
  if (myCatapult) {
    btnC.textContent = '박격포 ✓';
    btnC.style.opacity = '0.5'; btnC.style.cursor = 'not-allowed';
  } else {
    btnC.textContent = `박격포 (${SIEGE_COST})`;
    btnC.style.opacity = currency >= SIEGE_COST ? '1' : '0.4';
    btnC.style.cursor = currency >= SIEGE_COST ? 'pointer' : 'not-allowed';
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CURRENCY_MAX = 15;
const CURRENCY_AUTO_INTERVAL = 2; // seconds
const CURRENCY_MC = 1;   // multiple-choice correct
const CURRENCY_TYPE = 3; // typing correct
const ROUND_DURATION = 60; // seconds per round

// 1P AI spawn tables per round (cute-monster)
const AI_ROUNDS: Array<{ interval: number; pool: string[] }> = [
  { interval: 5.0, pool: ['m_chicken','m_bee','m_mushroom','m_penguin'] },
  { interval: 4.5, pool: ['m_crab','m_bat','m_pig','m_ghost','m_chicken'] },
  { interval: 4.0, pool: ['m_panda','m_deer','m_alien','m_skull','m_bat'] },
  { interval: 3.5, pool: ['m_greendemon','m_cyclops','m_cactus','m_demon','m_ghost'] },
  { interval: 3.0, pool: ['m_yeti','m_tree','m_alien_tall','m_cyclops','m_demon'] },
  { interval: 2.5, pool: ['m_cthulhu','m_yellowdragon','m_yeti','m_alien_tall','m_tree'] },
  { interval: 2.0, pool: ['m_cthulhu','m_yellowdragon','m_demon','m_cyclops','m_cthulhu'] },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type GameMode = '1p' | '2p';
type Screen = 'initial' | 'login' | 'signup' | 'loading' | 'home' | 'deck' | 'shop' | 'lobby2p' | 'battle' | 'result' | 'leaderboard';
let loggedInUsername = '';
let loggedInUserId = '';
let playerGold = 0;
let guestNickname = localStorage.getItem('zoo_nickname') || '';
let signupFrom: 'initial' | 'home' = 'initial'; // where signup was triggered from
let lbTab: 'words' | 'clear' = 'words';
let lbRefreshInterval: ReturnType<typeof setInterval> | null = null;
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
  dustMesh: THREE.Mesh | null;
  lastHp: number;
  mixer: THREE.AnimationMixer | null;
  currentAnim: string;
  // Special abilities
  stingerReady?: boolean;        // bee: true until first attack
  paralyzedUntil?: number;       // timestamp (seconds) when paralysis ends
  paralyzedLabel?: THREE.Sprite | null;
  jumpVel?: number;              // bunny: vertical velocity for gravity jump
  isLeaping?: boolean;           // tiger: arc in flight
  evadeLabel?: THREE.Sprite | null;
  evadeLabelTimer?: number;
  bossLabel?: THREE.Sprite | null; // boss name label above unit
  // ─── Food magic effects ───
  appleBuffed?: boolean;         // 사과: ATK ×2, ATKSPD ×2 (영구)
  greenAppleBuffed?: boolean;    // 초록사과: HP ×2, SPD ×2 (영구)
  visualScale?: number;          // multiplier on mesh.scale (food can grow unit ×2)
  hotEndTime?: number;           // 초록 피망: heal-over-time end
  hotPerSec?: number;            // hp restored per second
  hotNextTick?: number;          // next tick time
  dotEndTime?: number;           // 빨간 피망: damage-over-time end
  dotPerSec?: number;
  dotNextTick?: number;
  slowedUntil?: number;          // 아보카도 zone slow flag (frame-evaluated, not timestamp)
  slowFactor?: number;           // ground speed multiplier (0.4 = 60% slow)
  slowUntil?: number;            // 토마토 knockback slow end time
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
document.body.style.background = '#87ceeb';
document.body.appendChild(renderer.domElement);

function resizeRenderer() {
  const w = window.innerWidth, h = CANVAS_H();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0xb0dff0, 40, 90);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / CANVAS_H(), 0.1, 200);
resizeRenderer();
window.addEventListener('resize', resizeRenderer);

// ─── Particle System ──────────────────────────────────────────────────────────
interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  color: THREE.Color;
  size: number;
}
const activeParticles: Particle[] = [];
const MAX_PARTICLES = 300;

function spawnParticles(pos: THREE.Vector3, color: number, count: number, speed: number, lifespan: number) {
  if (!battleActive) return;
  for (let i = 0; i < count && activeParticles.length < MAX_PARTICLES; i++) {
    const angle = Math.random() * Math.PI * 2;
    const elevation = (Math.random() - 0.3) * Math.PI;
    const spd = speed * (0.5 + Math.random() * 0.5);
    activeParticles.push({
      position: pos.clone().add(new THREE.Vector3((Math.random()-0.5)*0.3, 0.2, (Math.random()-0.5)*0.3)),
      velocity: new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation) * spd,
        Math.abs(Math.sin(elevation)) * spd + 1,
        Math.sin(angle) * Math.cos(elevation) * spd
      ),
      life: lifespan,
      maxLife: lifespan,
      color: new THREE.Color(color),
      size: 0.15 + Math.random() * 0.15,
    });
  }
}

const particleGeo = new THREE.BufferGeometry();
const particlePositions = new Float32Array(MAX_PARTICLES * 3);
const particleColors = new Float32Array(MAX_PARTICLES * 3);
particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColors, 3));
const particleMat = new THREE.PointsMaterial({ size: 0.25, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
const particlePoints = new THREE.Points(particleGeo, particleMat);
particlePoints.frustumCulled = false;
scene.add(particlePoints);

function stepParticles(dt: number) {
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.life -= dt;
    if (p.life <= 0) { activeParticles.splice(i, 1); continue; }
    p.velocity.y -= 6 * dt; // gravity
    p.position.addScaledVector(p.velocity, dt);
  }
  const count = activeParticles.length;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    if (i < count) {
      particlePositions[i*3]   = activeParticles[i].position.x;
      particlePositions[i*3+1] = activeParticles[i].position.y;
      particlePositions[i*3+2] = activeParticles[i].position.z;
      const alpha = activeParticles[i].life / activeParticles[i].maxLife;
      particleColors[i*3]   = activeParticles[i].color.r * alpha;
      particleColors[i*3+1] = activeParticles[i].color.g * alpha;
      particleColors[i*3+2] = activeParticles[i].color.b * alpha;
    } else {
      particlePositions[i*3] = 0; particlePositions[i*3+1] = -100; particlePositions[i*3+2] = 0;
    }
  }
  (particleGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  (particleGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  particleMat.opacity = activeParticles.length > 0 ? 0.9 : 0;
}

// Lighting — 양쪽 대칭 조명
scene.add(new THREE.AmbientLight(0xffffff, 1.0));
scene.add(new THREE.HemisphereLight(0x87ceeb, 0x5aab3a, 0.6));
const sun = new THREE.DirectionalLight(0xfffde0, 1.1);
sun.position.set(8, 20, -6);
scene.add(sun);
const sun2 = new THREE.DirectionalLight(0xfffde0, 1.1); // 반대편 조명
sun2.position.set(-8, 20, -6);
scene.add(sun2);

// ─── Camera Pan ───────────────────────────────────────────────────────────────
let camPan = 0;
let camPanVel = 0;       // inertia velocity (units/sec)
let camPanStartX = 0;
let camPanActive = false;
let camPanLastDelta = 0; // last frame's pan delta for inertia kick
type CamMode = 'side' | 'top';
let camMode: CamMode = 'side';

renderer.domElement.addEventListener('pointerdown', (e) => {
  camPanActive = true;
  camPanStartX = e.clientX;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!camPanActive) return;
  const dx = e.clientX - camPanStartX;
  camPanStartX = e.clientX;
  const dir = localSide === 'p2' ? 1 : -1;
  camPanLastDelta = dir * dx * 0.05;
  camPan = Math.max(-15, Math.min(15, camPan + camPanLastDelta));
});
renderer.domElement.addEventListener('pointerup', () => {
  camPanActive = false;
  camPanVel = camPanLastDelta * 60;
});
renderer.domElement.addEventListener('pointercancel', () => {
  camPanActive = false;
  camPanVel = camPanLastDelta * 60; // preserve inertia on cancel (mobile scroll)
});

// ─── Field Geometry ───────────────────────────────────────────────────────────
function buildField() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, FIELD_LEN + 20),
    new THREE.MeshStandardMaterial({ color: 0x6db84a, roughness: 0.9 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.01, FIELD_LEN / 2);
  scene.add(ground);

  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(2.8, FIELD_LEN + 4),
    new THREE.MeshStandardMaterial({ color: 0x5a4020, roughness: 1.0 })
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, 0.005, FIELD_LEN / 2);
  scene.add(lane);

}
buildField();

// ─── Base Factory ─────────────────────────────────────────────────────────────
function makeBase(z: number, color: number, hp: number): BaseSim {
  // Flat platform — always visible as base; tower GLB sits on top
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(3, 0.4, 3),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
  );
  mesh.position.set(0, 0.2, z);
  scene.add(mesh);

  const hpSprite = makeHpSprite(hp, hp);
  hpSprite.position.set(0, 3.5, z);
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

function refreshHpSpriteUnit(u: UnitSim) {
  if (!u.hpSprite) return;
  const def = ANIMALS[u.animalId];
  const mat = u.hpSprite.material as THREE.SpriteMaterial;
  if (mat.map) mat.map.dispose();
  let canvas: HTMLCanvasElement;
  if (def.stinger) {
    canvas = drawHpCanvasBee(u.hp, u.maxHp, u.stingerReady ?? false);
  } else {
    canvas = drawHpCanvas(u.hp, u.maxHp);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  mat.map = tex;
  mat.needsUpdate = true;
}

function drawHpCanvasBee(hp: number, maxHp: number, hasStinger: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 128, 24);
  const frac = Math.max(0, hp / maxHp);
  const r = Math.round(255 * (1 - frac));
  const g = Math.round(255 * frac);
  ctx.fillStyle = `rgb(${r},${g},0)`;
  ctx.fillRect(2, 2, Math.round(124 * frac), 20);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.ceil(hp)}`, 64, 12);
  // Stinger indicator
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = hasStinger ? '#44ff44' : '#ff4444';
  ctx.textAlign = 'center';
  ctx.fillText(hasStinger ? 'o' : 'x', 64, 27);
  return c;
}

// ─── Unit Mesh Factory ────────────────────────────────────────────────────────
const MODEL_SCALE: Record<string, number> = {
  lion: 1.1, elephant: 1.5, eagle: 0.65, monkey: 0.85, mole: 0.75,
  bee: 0.4, bunny: 0.6, cat: 0.6, chick: 0.38, cow: 1.1,
  crab: 0.55, deer: 1.05, dog: 0.85, fox: 0.7, giraffe: 1.5,
  hog: 0.9, koala: 0.8, panda: 0.9, penguin: 0.65, pig: 0.85,
  polar: 1.1, tiger: 1.2,
  // cute-monster
  m_chicken:0.5, m_bee:0.5, m_mushroom:0.5, m_crab:0.5, m_bat:0.5,
  m_penguin:0.5, m_pig:0.65, m_panda:0.65, m_deer:0.65, m_alien:0.65,
  m_ghost:0.65, m_skull:0.65, m_greendemon:0.65, m_cyclops:0.65,
  m_cactus:0.65, m_demon:0.65, m_yeti:0.85, m_tree:0.85,
  m_alien_tall:0.85, m_cthulhu:0.85, m_yellowdragon:0.85,
};

function makeUnitMesh(def: AnimalDef, side: Side): THREE.Object3D {
  const template = modelTemplates[def.id]?.scene;
  if (!template) {
    // Fallback box if model not loaded yet
    return new THREE.Mesh(
      new THREE.BoxGeometry(def.size * 2, def.size * 2, def.size * 2),
      new THREE.MeshStandardMaterial({ color: def.color })
    );
  }

  // SkinnedMesh (rigged) models need SkeletonUtils.clone to rebind bones correctly
  const model = def.id.startsWith('m_')
    ? skeletonClone(template) as THREE.Group
    : template.clone(true);
  const s = MODEL_SCALE[def.id] ?? def.size;
  model.scale.set(s, s, s);

  // p2 faces the opposite direction (toward p1 base)
  if (side === 'p2') model.rotation.y = Math.PI;

  // Tint units by team color
  const unitTeam = side === 'p1' ? p1Team : p2Team;
  model.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const applyTint = (m: THREE.Material) => {
        const c = (m as THREE.MeshStandardMaterial).clone();
        if (unitTeam === 'red') {
          c.color.r = Math.min(1, c.color.r * 1.1 + 0.08);
          c.color.b = c.color.b * 0.6;
        } else {
          c.color.r = c.color.r * 0.75;
          c.color.b = Math.min(1, c.color.b + 0.35);
        }
        return c;
      };
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(applyTint)
        : applyTint(mesh.material as THREE.Material);
    }
  });

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

function spawnUnit(animalId: string, side: Side, forcedId?: string, forcedX?: number, forcedZ?: number): UnitSim {
  const def = ANIMALS[animalId];
  const id = forcedId ?? `u${++unitIdCounter}`;
  const z = forcedZ ?? (side === 'p1' ? SPAWN_P1 : SPAWN_P2);
  const x = forcedX ?? (Math.random() - 0.5) * 5;

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

  // Hog: animation runs at 3× speed for charge feel
  let mixer: THREE.AnimationMixer | null = null;
  let currentAnim = '';
  const tmpl = modelTemplates[animalId];
  if (tmpl && tmpl.animations.length > 0) {
    mixer = new THREE.AnimationMixer(mesh);
    const initClip = tmpl.animations.find(c => c.name === 'walk') ?? tmpl.animations[0];
    const action = mixer.clipAction(initClip);
    if (def.charge) action.setEffectiveTimeScale(3.0);
    action.play();
    currentAnim = initClip.name;
  }

  const unit: UnitSim = {
    id, animalId, side, z, x,
    hp: def.hp, maxHp: def.hp,
    state: def.layer === 'underground' ? 'underground' : 'moving',
    atkTimer: 0,
    mesh, hpSprite, dustMesh,
    lastHp: def.hp,
    mixer, currentAnim,
    stingerReady: def.stinger ? true : undefined,
    jumpVel: def.jumping ? 5 : (def.leap ? 0 : undefined),
  };
  units.push(unit);
  // Spawn particles
  spawnParticles(new THREE.Vector3(x, 0.5, z), ANIMALS[animalId]?.color ?? 0x88aaff, 8, 2.5, 0.4);
  return unit;
}

function makeTextSprite(text: string, color = '#ffffff', scale = 1.5): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 32);
  ctx.font = 'bold 14px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scale, scale * 0.28, 1);
  return sp;
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
  if (unit.mixer) { unit.mixer.stopAllAction(); unit.mixer = null; }
  if (unit.paralyzedLabel) { scene.remove(unit.paralyzedLabel); unit.paralyzedLabel = null; }
  if (unit.evadeLabel) { scene.remove(unit.evadeLabel); unit.evadeLabel = null; }
  if (unit.bossLabel) { scene.remove(unit.bossLabel); unit.bossLabel = null; }
}

// ─── Unit AI ──────────────────────────────────────────────────────────────────
const JUMP_GRAVITY = -22;
const JUMP_INIT_VEL = 6;

function canAttackEnemy(def: AnimalDef, enemyDef: AnimalDef): boolean {
  if (def.attackLayer === 'ground' && enemyDef.layer === 'air') return false;
  return true;
}

// AOE wrapper: hit primary target + all enemies within def.aoe radius
function dealDamageAOE(attacker: UnitSim, primary: UnitSim, def: AnimalDef, allEnemies: UnitSim[], now: number) {
  const atk = attacker.appleBuffed ? def.atk * 2 : def.atk;
  dealDamage(attacker, primary, atk, now);
  if (def.aoe) {
    for (const e of allEnemies) {
      if (e !== primary && Math.abs(e.z - primary.z) <= def.aoe && e.state !== 'dead') {
        dealDamage(attacker, e, atk, now);
      }
    }
  }
}

function dealDamage(attacker: UnitSim, target: UnitSim, atk: number, now: number): boolean {
  const tDef = ANIMALS[target.animalId];
  // Cat evasion
  if (tDef.evasion && Math.random() < tDef.evasion) {
    showEvadeLabel(target);
    return false;
  }
  // Bee stinger: first attack paralyzes
  const aDef = ANIMALS[attacker.animalId];
  if (aDef.stinger && attacker.stingerReady) {
    attacker.stingerReady = false;
    target.paralyzedUntil = now + 1.5;
    refreshBeeStingerLabel(attacker);
    showParalyzedLabel(target);
  }
  target.hp = Math.max(0, target.hp - atk);
  if (target.hp <= 0) target.state = 'dead';
  return true;
}

function showParalyzedLabel(u: UnitSim) {
  if (!u.paralyzedLabel) {
    u.paralyzedLabel = makeTextSprite('paralyzed', '#ff4444', 1.8);
    scene.add(u.paralyzedLabel);
  }
}

function showEvadeLabel(u: UnitSim) {
  if (u.evadeLabel) scene.remove(u.evadeLabel);
  u.evadeLabel = makeTextSprite('Evade!', '#44ffaa', 1.6);
  u.evadeLabelTimer = 0.6;
  if (u.mesh) u.evadeLabel.position.copy(u.mesh.position).y += u.mesh.position.y + 1.5;
  scene.add(u.evadeLabel);
}

function refreshBeeStingerLabel(bee: UnitSim) {
  // Bee's stinger status shown in HP sprite — force refresh
  bee.lastHp = -1;
}

function stepUnits(dt: number) {
  const now = battleClock;
  const alive = units.filter(u => u.state !== 'dead');

  for (const u of alive) {
    if (u.state === 'dead') continue;
    u.atkTimer = Math.max(0, u.atkTimer - dt);

    // Bunny: continuous gravity bounce
    const def = ANIMALS[u.animalId];
    if (!def) continue;
    if (def.jumping && u.jumpVel !== undefined) {
      u.jumpVel += JUMP_GRAVITY * dt;
      const baseY = def.size;
      let newY = (u.mesh?.position.y ?? baseY) + u.jumpVel * dt;
      if (newY <= baseY) { newY = baseY; u.jumpVel = JUMP_INIT_VEL; }
      if (u.mesh) u.mesh.position.y = newY;
    }

    // Tiger leap arc: physics while isLeaping; clear isLeaping on landing
    if (def.leap && u.jumpVel !== undefined && u.jumpVel !== 0) {
      u.jumpVel += JUMP_GRAVITY * dt;
      const baseY = def.size;
      const curY = u.mesh?.position.y ?? baseY;
      let newY = curY + u.jumpVel * dt;
      if (newY <= baseY) { newY = baseY; u.jumpVel = 0; u.isLeaping = false; }
      if (u.mesh) u.mesh.position.y = newY;
    }

    // Evade label fade-out
    if (u.evadeLabel && u.evadeLabelTimer !== undefined) {
      u.evadeLabelTimer -= dt;
      const mat = u.evadeLabel.material as THREE.SpriteMaterial;
      mat.opacity = Math.max(0, u.evadeLabelTimer / 0.6);
      if (u.evadeLabelTimer <= 0) { scene.remove(u.evadeLabel); u.evadeLabel = null; }
    }

    // Paralysis: show/hide label
    if (u.paralyzedUntil) {
      if (now < u.paralyzedUntil) {
        showParalyzedLabel(u);
      } else {
        if (u.paralyzedLabel) { scene.remove(u.paralyzedLabel); u.paralyzedLabel = null; }
        u.paralyzedUntil = undefined;
      }
    }

    // Skip AI if paralyzed
    if (u.paralyzedUntil && now < u.paralyzedUntil) continue;

    const dir = u.side === 'p1' ? 1 : -1;
    const targetBase = u.side === 'p1' ? p2Base : p1Base;
    const enemies = alive.filter(e => e.side !== u.side && e.state !== 'underground' && e.state !== 'dead');

    if (def.layer === 'underground') {
      stepMole(u, dt, dir, enemies, targetBase, now);
    } else {
      stepGroundOrAir(u, dt, dir, def, enemies, targetBase, now);
    }

    // Hard clamp: units cannot penetrate past the enemy base
    const BASE_STOP_DIST = 2.5;
    if (dir > 0) {
      if (u.z > targetBase.z - BASE_STOP_DIST) { u.z = targetBase.z - BASE_STOP_DIST; if (u.mesh) u.mesh.position.z = u.z; }
    } else {
      if (u.z < targetBase.z + BASE_STOP_DIST) { u.z = targetBase.z + BASE_STOP_DIST; if (u.mesh) u.mesh.position.z = u.z; }
    }
  }
}

// Food buff helpers — read effective stats with apple/green-apple/avocado mods
function effSpd(u: UnitSim, def: AnimalDef): number {
  let s = def.spd;
  if (u.greenAppleBuffed) s *= 2;
  // Avocado slow (refreshed each frame while inside zone)
  if (u.slowedUntil && battleClock < u.slowedUntil) s *= (u.slowFactor ?? 1);
  // Tomato knockback slow
  const slowMult = (u.slowUntil && battleClock < u.slowUntil) ? (u.slowFactor ?? 1) : 1;
  s *= slowMult;
  return s;
}
function effAtk(u: UnitSim, def: AnimalDef): number {
  return u.appleBuffed ? def.atk * 2 : def.atk;
}
function effAtkCooldown(u: UnitSim, def: AnimalDef): number {
  return u.appleBuffed ? def.atkCooldown / 2 : def.atkCooldown;
}

function stepGroundOrAir(u: UnitSim, dt: number, dir: number, def: AnimalDef, enemies: UnitSim[], base: BaseSim, now: number) {
  const attackable = enemies.filter(e => canAttackEnemy(def, ANIMALS[e.animalId]));
  let closest: UnitSim | null = null;
  let closestDist = Infinity;
  for (const e of attackable) {
    const d = Math.abs(e.z - u.z);
    if (d < closestDist) { closestDist = d; closest = e; }
  }
  const baseDist = Math.abs(base.z - u.z);

  // Tiger leap: pounce toward enemy whenever within leapRange and outside attack range
  if (def.leap && u.isLeaping) return; // mid-arc: physics controls position
  if (def.leap && closest && closestDist <= (def.leapRange ?? 5) && closestDist > def.range) {
    u.isLeaping = true;
    const toEnemy = Math.sign(closest.z - u.z);
    const jumpDist = closestDist - def.range;
    u.z = Math.max(SPAWN_P1, Math.min(SPAWN_P2, u.z + toEnemy * jumpDist));
    if (u.jumpVel !== undefined) u.jumpVel = JUMP_INIT_VEL;
    u.state = 'moving';
    return;
  }

  if (def.ranged) {
    if (closest && closestDist <= def.range) {
      u.state = 'attacking';
      if (u.atkTimer <= 0) { dealDamageAOE(u, closest, def, attackable, now); u.atkTimer = effAtkCooldown(u, def); sfx('attack'); }
      return;
    }
    if (baseDist <= def.range) {
      u.state = 'attacking';
      if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - effAtk(u, def)); u.atkTimer = effAtkCooldown(u, def); sfx('base_hit'); }
      return;
    }
    u.state = 'moving'; u.z += dir * effSpd(u, def) * dt; return;
  }

  if (closest && closestDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { dealDamageAOE(u, closest, def, attackable, now); u.atkTimer = effAtkCooldown(u, def); sfx('attack'); }
    return;
  }
  if (baseDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - effAtk(u, def)); u.atkTimer = effAtkCooldown(u, def); sfx('base_hit'); }
    return;
  }
  u.state = 'moving';
  u.z += dir * effSpd(u, def) * dt;
}

function stepMole(u: UnitSim, dt: number, dir: number, enemies: UnitSim[], base: BaseSim, now: number) {
  const def = ANIMALS['mole'];
  const groundEnemies = enemies.filter(e => ANIMALS[e.animalId].layer !== 'air');
  const baseDist = Math.abs(base.z - u.z);

  if (u.state === 'underground') {
    // surface only near the base — ignore ground enemies entirely
    if (baseDist <= 6) { u.state = 'moving'; }
    else { u.z += dir * def.spd * dt; }
    return;
  }

  const nearest = groundEnemies.reduce<UnitSim | null>((best, e) => {
    const d = Math.abs(e.z - u.z);
    return !best || d < Math.abs(best.z - u.z) ? e : best;
  }, null);

  if (nearest && Math.abs(nearest.z - u.z) <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { dealDamage(u, nearest, def.atk, now); u.atkTimer = def.atkCooldown; }
    return;
  }
  if (baseDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - def.atk); u.atkTimer = def.atkCooldown; sfx('base_hit'); }
    return;
  }
  if (nearest) { u.state = 'moving'; u.z += dir * def.spd * dt; return; }
  // near base: keep moving on ground instead of going back underground
  if (baseDist <= 6) { u.state = 'moving'; u.z += dir * 3 * dt; return; }
  u.state = 'underground';
}

// ─── Animation Helper ─────────────────────────────────────────────────────────
function playAnim(u: UnitSim, name: string) {
  if (!u.mixer) return;
  // Boss units: map generic state name → boss-specific clip name
  const bossDef = BOSS_DEFS[u.animalId];
  let clipName = name;
  if (bossDef) {
    if (name === 'walk' || name === 'static') clipName = bossDef.animWalk;
    else if (name === 'eat') clipName = bossDef.animAtk;
  } else if (u.animalId.startsWith('m_')) {
    const mDef = ANIMALS[u.animalId];
    if (name === 'walk' || name === 'static') clipName = mDef?.layer === 'air' ? 'Flying' : 'Walk';
    else if (name === 'eat') clipName = 'Bite_Front';
  }
  if (u.currentAnim === clipName) return;
  // Get clips from boss template or regular model template
  const clips = bossDef
    ? (bossTemplates[u.animalId]?.animations ?? [])
    : (modelTemplates[u.animalId]?.animations ?? []);
  const clip = clips.find(c => c.name.includes(clipName)) ?? clips[0];
  if (!clip) return;
  u.mixer.stopAllAction();
  u.mixer.clipAction(clip).reset().fadeIn(0.15).play();
  u.currentAnim = clipName;
}

const STATE_ANIM: Record<UnitState, string> = {
  moving: 'walk',
  attacking: 'eat',
  underground: 'static',
  dead: 'static',
};

// ─── Three.js Unit Sync (after simulation step) ───────────────────────────────
function syncUnitMeshes() {
  const toRemove: UnitSim[] = [];

  for (const u of units) {
    if (u.state === 'dead') {
      toRemove.push(u);
      continue;
    }
    const def = ANIMALS[u.animalId];
    if (!def) { console.warn('[syncUnitMeshes] missing def for', u.animalId); continue; }
    const underground = u.state === 'underground' && def.layer === 'underground';
    const airY = def.layer === 'air' ? AIR_Y : (def.baseY ?? def.size);
    const yPos = underground ? -5 : airY;

    if (u.mesh) {
      // Bunny/leaping tiger: Y controlled by physics, only update x/z
      const physicsY = def.jumping || (def.leap && (u.jumpVel ?? 0) !== 0);
      if (physicsY) {
        u.mesh.position.x = u.x;
        u.mesh.position.z = u.z;
      } else {
        u.mesh.position.set(u.x, yPos, u.z);
      }
      u.mesh.visible = !underground;
    }
    playAnim(u, STATE_ANIM[u.state] ?? 'walk');
    const meshY = u.mesh ? u.mesh.position.y : yPos;
    if (u.hpSprite) {
      u.hpSprite.position.set(u.x, meshY + def.size + 0.6, u.z);
      u.hpSprite.visible = !underground;
      const stingerChanged = def.stinger && u.lastHp === u.hp; // force refresh when stinger fires
      if (u.hp !== u.lastHp || stingerChanged) {
        refreshHpSpriteUnit(u);
        u.lastHp = u.hp;
      }
    }
    if (u.dustMesh) {
      u.dustMesh.position.set(u.x, 0.05, u.z);
      u.dustMesh.visible = underground;
    }
    // Paralyzed / evade / boss label positions
    if (u.paralyzedLabel) u.paralyzedLabel.position.set(u.x, meshY + def.size + 1.3, u.z);
    if (u.evadeLabel) u.evadeLabel.position.set(u.x, meshY + def.size + 1.3, u.z);
    if (u.bossLabel) u.bossLabel.position.set(u.x, meshY + def.size + 2.6, u.z);
  }

  for (const u of toRemove) {
    if (gameMode === '1p' && u.side === 'p2' && battleActive) {
      if (u.animalId in BOSS_DEFS) {
        p1BossesKilled++;
        if (u.animalId === 'dragon') p1DragonKilled = true;
      } else if (u.animalId.startsWith('m_')) {
        p1MonstersKilled++;
      }
    }
    // Death particles
    spawnParticles(new THREE.Vector3(u.x, 1, u.z), ANIMALS[u.animalId]?.color ?? 0xffffff, 12, 4, 0.6);
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
  updateTowerVisual('p1');
  updateTowerVisual('p2');
}

// ─── Game State ───────────────────────────────────────────────────────────────
let gameMode: GameMode = '1p';
let currentScreen: Screen = 'initial';
let battleActive = false;
let battleClock = 0; // elapsed seconds since battle start (for paralysis timing)

let currency = 0;
let autoCurrencyTimer = 0;
let round = 1;

// Quiz event
let quizEventActive = false;
let quizEventPhase: 'study' | 'quiz' | 'result' = 'study';
let quizEventPhaseTimer = 0;
let quizEventWords: typeof wordList = [];
let quizEventQuestion: typeof wordList[0] | null = null;
let quizEventChoices: string[] = [];
let quizEventAnswered = false;
let quizEventTriggerTimer = 60; // seconds until next quiz event
let roundTimer = 0;
let aiSpawnTimer = 0;

let multiplayerTimeLeft = 120;

let currentWord = wordList[0];
let currentChoices: string[] = [];
let correctIdx = 0;
// ─── Battle Stats (for result screen) ────────────────────────────────────────
let p1MonstersKilled = 0;
let p1BossesKilled = 0;
let p1DragonKilled = false;
let correctWords: { en: string; ko: string }[] = [];
let wrongWords = 0;
let spamWrongLog: number[] = []; // timestamps of recent wrong answers
let spamLockUntil = 0; // battleClock value when lock expires
let isTypingMode = false;

// 2P socket state
const socketUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? window.location.origin;
const socket = io(socketUrl, {
  path: '/socket.io',
  transports: ['websocket', 'polling'],  // polling fallback for restrictive networks
  autoConnect: false,
  reconnectionAttempts: 3,
  timeout: 8000,
});
let localSide: Side = 'p1';

// ─── HTML Screens ─────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;

document.body.insertAdjacentHTML('beforeend', `
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;color:#e8eefc;touch-action:manipulation;}
  .screen{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:url('${import.meta.env.BASE_URL}ui/PNG/menu/bg.png') center/cover no-repeat;z-index:50;}
  .screen.hidden{display:none;}
  /* jungle panel */
  .jui-panel{background:rgba(12,30,8,0.82);border:2px solid rgba(80,200,60,0.4);border-radius:18px;padding:28px 28px;width:100%;max-width:320px;display:flex;flex-direction:column;gap:10px;box-shadow:0 6px 40px rgba(0,0,0,0.65);}
  /* buttons */
  .btn{padding:12px 28px;border-radius:14px;border:2px solid rgba(60,180,40,0.5);background:linear-gradient(180deg,#3a7a20,#1e5010);color:#e8ffdc;font-size:16px;font-weight:700;cursor:pointer;transition:filter 0.08s,transform 0.08s;text-shadow:0 1px 3px rgba(0,0,0,0.6);box-shadow:0 3px 0 rgba(0,0,0,0.45),0 0 10px rgba(60,200,40,0.12);}
  .btn:hover{filter:brightness(1.22);}
  .btn:active{filter:brightness(1.4) drop-shadow(0 0 6px rgba(255,255,255,0.6));transform:scale(0.97);}
  .btn.primary{background:linear-gradient(180deg,#52cc28,#2b8410);border-color:rgba(120,255,80,0.65);color:#fff;}
  .btn.primary:hover{filter:brightness(1.15);}
  .btn.primary:active{filter:brightness(1.5) drop-shadow(0 0 8px rgba(80,200,120,0.8));}
  .btn.green{background:linear-gradient(180deg,#3aaa50,#1a6030);border-color:rgba(80,220,120,0.5);color:#a0ffb8;}
  .btn.green:hover{filter:brightness(1.2);}
  .btn.danger{background:linear-gradient(180deg,#c04030,#8a1020);border-color:rgba(255,80,60,0.5);}
  .btn:disabled{opacity:0.4;cursor:not-allowed;filter:none;}
  .full-btn{width:100%;padding:14px;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;transition:filter 0.12s;}
  /* title */
  .jui-title{font-size:3.4em;font-weight:900;color:#fff;text-shadow:0 2px 0 #1e5508,0 4px 14px rgba(0,0,0,0.75),0 0 36px rgba(80,230,40,0.55);letter-spacing:3px;margin:0 0 28px;text-align:center;}
  h2{font-size:1.6em;margin:0 0 16px;text-shadow:0 2px 6px rgba(0,0,0,0.65);}
  input.field{padding:10px 14px;border-radius:10px;border:1px solid rgba(80,200,60,0.45);background:rgba(255,255,255,0.10);color:#e8eefc;font-size:15px;outline:none;width:100%;}
  input.field:focus{border-color:rgba(110,255,80,0.75);background:rgba(255,255,255,0.14);}
  .gap{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;}
  .animal-card{padding:12px 16px;border-radius:12px;border:2px solid rgba(80,200,60,0.2);background:rgba(12,35,8,0.75);min-width:110px;text-align:center;font-size:13px;cursor:default;}
  .animal-card .aname{font-size:15px;font-weight:700;margin-bottom:6px;}
  .animal-card .astat{opacity:0.75;line-height:1.6;}
  #screen-deck{background:linear-gradient(rgba(5,18,3,0.78),rgba(5,18,3,0.78)),url('${import.meta.env.BASE_URL}ui/PNG/menu/bg.png') center/cover no-repeat;}
  @keyframes chest-shake{0%,100%{transform:translateX(0) rotate(0deg);}20%{transform:translateX(-8px) rotate(-3deg);}40%{transform:translateX(8px) rotate(3deg);}60%{transform:translateX(-6px) rotate(-2deg);}80%{transform:translateX(6px) rotate(2deg);}}
  .chest-shaking{animation:chest-shake 0.55s ease-in-out;}
  .chest-card{background:rgba(10,25,6,0.82);border:2px solid rgba(80,200,60,0.2);border-radius:16px;padding:14px 10px;display:flex;flex-direction:column;align-items:center;gap:10px;}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>

<!-- INITIAL -->
<div id="screen-initial" class="screen">
  <div class="jui-title">Zoo Battle</div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:14px;width:248px;">
    <div style="width:100%;">
      <div style="font-size:13px;color:#aac;margin-bottom:6px;text-align:left;">닉네임</div>
      <input class="field" id="in-nickname" placeholder="닉네임 입력 (최대 12자)" maxlength="12" autocomplete="off" style="text-align:center;font-size:16px;">
      <div id="nickname-error" style="color:#ff9090;font-size:12px;min-height:16px;text-align:center;margin-top:4px;"></div>
    </div>
    <button class="btn primary full-btn" id="btn-start" style="font-size:20px;padding:16px 28px;">시작하기</button>
    <button class="btn full-btn" id="btn-load-progress" style="font-size:14px;padding:11px;opacity:0.88;">로그인 (진행상황 불러오기)</button>
  </div>
</div>

<!-- LOGIN -->
<div id="screen-login" class="screen hidden">
  <div class="jui-panel">
    <h2 style="text-align:center;margin-bottom:4px;">로그인</h2>
    <input class="field" id="in-login-id" placeholder="아이디" autocomplete="username">
    <input class="field" id="in-login-pw" type="password" placeholder="비밀번호" autocomplete="current-password">
    <div id="login-error" style="color:#ff9090;font-size:13px;min-height:18px;text-align:center;"></div>
    <button class="btn primary full-btn" id="btn-login">로그인</button>
    <button class="btn green full-btn" id="btn-go-signup">아이디 생성</button>
    <button class="btn full-btn" id="btn-login-back" style="opacity:0.65;font-size:13px;padding:10px;">← 돌아가기</button>
  </div>
</div>

<!-- SIGNUP -->
<div id="screen-signup" class="screen hidden">
  <div class="jui-panel">
    <h2 style="text-align:center;margin-bottom:4px;">아이디 생성</h2>
    <div id="signup-hint" style="display:none;background:rgba(65,193,255,0.12);border:1px solid rgba(65,193,255,0.35);border-radius:10px;padding:10px 12px;font-size:13px;color:#a8e6ff;text-align:center;line-height:1.5;">아이디를 만들면 현재 덱과 골드가<br>자동으로 저장됩니다</div>
    <input class="field" id="in-signup-id" placeholder="아이디" autocomplete="username">
    <input class="field" id="in-signup-pw1" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="new-password">
    <input class="field" id="in-signup-pw2" type="password" placeholder="비밀번호 확인" autocomplete="new-password">
    <div id="signup-error" style="color:#ff9090;font-size:13px;min-height:18px;text-align:center;"></div>
    <button class="btn primary full-btn" id="btn-signup-confirm">아이디 생성</button>
    <button class="btn full-btn" id="btn-signup-back" style="opacity:0.65;font-size:13px;padding:10px;">← 돌아가기</button>
  </div>
</div>

<!-- LOADING -->
<div id="screen-loading" class="screen hidden">
  <div class="jui-panel" style="align-items:center;padding:32px 40px;">
    <div style="width:48px;height:48px;border:5px solid rgba(255,255,255,0.15);border-top-color:#60d840;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
    <div style="color:#a0ffb8;font-size:16px;font-weight:700;margin-top:16px;">불러오는 중...</div>
  </div>
</div>

<!-- HOME -->
<div id="screen-home" class="screen hidden">
  <div style="position:absolute;top:0;left:0;right:0;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;background:rgba(10,28,5,0.78);border-bottom:1px solid rgba(80,200,60,0.28);">
    <span id="home-username" style="font-size:14px;color:#a0ffb8;font-weight:700;">Guest</span>
    <span id="home-gold" style="font-size:14px;color:#ffd060;font-weight:700;">0 G</span>
  </div>
  <div class="jui-title">Zoo Battle</div>
  <div style="display:flex;flex-direction:column;align-items:center;gap:10px;width:248px;">
    <button class="btn primary full-btn" id="btn-home-1p" style="font-size:17px;">혼자서 플레이</button>
    <button class="btn primary full-btn" id="btn-home-2p" style="font-size:17px;">둘이서 플레이</button>
    <button class="btn full-btn" id="btn-home-deck">덱 구성</button>
    <button class="btn full-btn" id="btn-home-shop" style="font-size:14px;">상점</button>
    <button class="btn full-btn" id="btn-home-leaderboard" style="font-size:14px;">랭킹 보기</button>
    <button class="btn full-btn" id="btn-home-save" style="opacity:0.72;font-size:13px;padding:10px;">진행상황 저장하기</button>
  </div>
</div>

<!-- DECK -->
<div id="screen-deck" class="screen hidden" style="padding:16px;justify-content:flex-start;padding-top:28px;">
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:14px;width:100%;max-width:640px;">
    <h2 style="margin:0;flex:1;">덱 구성</h2>
    <span id="deck-count" style="font-size:14px;color:#a0ffb8;white-space:nowrap;font-weight:700;">0 / 6 선택</span>
  </div>
  <div id="deck-cards" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;overflow-y:auto;width:100%;max-width:640px;flex:1;align-content:start;padding-bottom:8px;"></div>
  <div style="margin-top:14px;width:100%;max-width:640px;" class="gap">
    <button class="btn" id="btn-deck-back">← 저장하고 돌아가기</button>
  </div>
</div>

<!-- SHOP -->
<div id="screen-shop" class="screen hidden" style="justify-content:flex-start;overflow-y:auto;padding:0;">
  <div style="width:100%;max-width:700px;padding:20px 16px 32px;display:flex;flex-direction:column;align-items:center;gap:20px;">
    <div style="width:100%;display:flex;justify-content:space-between;align-items:center;">
      <button class="btn" id="btn-shop-back" style="padding:10px 18px;font-size:14px;">← 돌아가기</button>
      <h2 style="margin:0;">상점</h2>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <span id="shop-gold" style="font-size:14px;color:#ffd060;font-weight:700;">0 G</span>
        <span id="shop-owned" style="font-size:11px;color:#a0ffb8;opacity:0.8;">보유 0 / 0</span>
      </div>
    </div>
    <div id="shop-chest-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;width:100%;max-width:480px;"></div>
  </div>
</div>

<!-- CHEST OPENING OVERLAY -->
<div id="chest-overlay" style="display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.90);flex-direction:column;align-items:center;justify-content:center;gap:0;">
  <img id="chest-anim-img" src="" alt="" style="width:260px;height:auto;transition:opacity 0.18s;">
  <div id="chest-result-card" style="display:none;margin-top:18px;"></div>
  <button id="btn-chest-close" class="btn primary" style="margin-top:20px;opacity:0;pointer-events:none;padding:12px 36px;">닫기</button>
</div>

<!-- CHEST INFO OVERLAY -->
<div id="chest-info-overlay" style="display:none;position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.8);align-items:center;justify-content:center;">
  <div style="background:rgba(16,20,48,0.98);border:2px solid rgba(255,255,255,0.2);border-radius:16px;padding:20px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto;">
    <div id="chest-info-title" style="font-size:16px;font-weight:900;margin-bottom:12px;"></div>
    <div id="chest-info-list" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
    <button id="btn-chest-info-close" class="btn" style="margin-top:16px;width:100%;">닫기</button>
  </div>
</div>

<!-- 2P LOBBY -->
<div id="screen-lobby2p" class="screen hidden">
  <div class="jui-panel" style="align-items:center;text-align:center;">
    <h2 style="margin:0 0 14px;">2인 대전 로비</h2>
    <input class="field" id="in-room" placeholder="방 코드 (예: BATTLE1)" style="margin-bottom:10px;text-align:center;">
    <div class="gap" style="margin-bottom:10px;justify-content:center;">
      <button class="btn" id="btn-rndroom">랜덤 코드</button>
      <button class="btn primary" id="btn-joinroom">참가</button>
    </div>
    <div id="lobby-status" style="font-size:13px;opacity:0.8;min-height:20px;"></div>
    <button class="btn" id="btn-lobby-back" style="margin-top:14px;opacity:0.72;">← 돌아가기</button>
  </div>
</div>

<!-- RESULT -->
<div id="screen-result" class="screen hidden" style="justify-content:flex-start;overflow-y:auto;padding:0;">
  <div style="width:100%;max-width:520px;padding:24px 16px 32px;display:flex;flex-direction:column;align-items:center;gap:14px;">
    <img id="result-header-img" src="" alt="" style="max-width:300px;width:80%;filter:drop-shadow(0 4px 14px rgba(0,0,0,0.55));">
    <div id="result-stats" style="width:100%;display:none;"></div>
    <div id="result-words" style="width:100%;display:none;"></div>
    <button class="btn primary" id="btn-result-menu" style="font-size:17px;padding:14px 44px;">홈으로</button>
  </div>
</div>

<!-- LEADERBOARD -->
<div id="screen-leaderboard" class="screen hidden" style="justify-content:flex-start;overflow-y:auto;padding:0;">
  <div style="width:100%;max-width:480px;padding:16px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
      <button class="btn" id="btn-lb-back" style="padding:8px 14px;font-size:13px;">← 돌아가기</button>
      <div style="font-size:20px;font-weight:900;color:#ffd700;">랭킹</div>
      <button class="btn" id="btn-lb-refresh" style="padding:8px 14px;font-size:13px;margin-left:auto;">새로고침</button>
    </div>
    <!-- Tab buttons -->
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <button id="lb-tab-words" class="btn primary" style="flex:1;padding:10px;font-size:14px;">단어 랭킹</button>
      <button id="lb-tab-clear" class="btn" style="flex:1;padding:10px;font-size:14px;">클리어 랭킹</button>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div id="lb-status" style="font-size:12px;color:#aaa;"></div>
      <button id="btn-lb-delete" class="btn" style="padding:5px 10px;font-size:12px;color:#ff8080;border-color:rgba(255,100,100,0.3);display:none;">내 기록 삭제</button>
    </div>
    <div id="lb-list" style="display:flex;flex-direction:column;gap:4px;"></div>
  </div>
</div>

<!-- QUIZ EVENT OVERLAY -->
<div id="quiz-event-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:rgba(16,20,48,0.98);border:2px solid rgba(255,215,0,0.4);border-radius:20px;padding:32px 36px;max-width:500px;width:92%;text-align:center;color:#fff;box-shadow:0 0 40px rgba(0,0,0,0.8);">
    <div id="qe-title" style="font-size:18px;font-weight:bold;color:#ffd700;margin-bottom:18px;"></div>
    <div id="qe-study" style="display:none;">
      <div id="qe-word-list" style="text-align:left;"></div>
    </div>
    <div id="qe-quiz" style="display:none;">
      <div style="font-size:14px;color:#aaa;margin-bottom:8px;">다음 단어의 뜻은?</div>
      <div id="qe-question" style="font-size:30px;font-weight:bold;color:#7ad7f0;margin-bottom:20px;letter-spacing:2px;"></div>
      <div id="qe-choices" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
    <div id="qe-result" style="display:none;font-size:22px;font-weight:bold;min-height:60px;display:flex;align-items:center;justify-content:center;"></div>
    <div style="margin-top:18px;height:6px;background:rgba(255,255,255,0.1);border-radius:3px;overflow:hidden;">
      <div id="qe-timer-fill" style="height:100%;background:#ffd700;border-radius:3px;width:100%;transition:width 0.1s linear;"></div>
    </div>
  </div>
</div>

<!-- TOP HUD (HP bars + timer) — 적 기지 왼쪽 / 내 기지 오른쪽 고정 -->
<div id="top-hud" style="display:none;position:fixed;top:0;left:0;right:0;z-index:100;background:rgba(0,0,0,0.80);padding:6px 14px;">
  <div style="display:flex;align-items:center;gap:10px;">
    <div style="flex:1;">
      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
        <span style="color:#ff8888;font-weight:700;">적 기지 🏰</span>
        <span id="hp-foe-text" style="color:#fcc;">60/60</span>
      </div>
      <div style="height:16px;background:#1a1a2e;border-radius:6px;overflow:hidden;">
        <div id="bar-foe" style="height:100%;width:100%;background:linear-gradient(90deg,#ff5555,#cc2222);border-radius:6px;transition:width 0.15s;"></div>
      </div>
    </div>
    <div style="text-align:center;min-width:80px;">
      <div id="top-timer" style="font-size:26px;font-weight:900;color:#fff;line-height:1;font-variant-numeric:tabular-nums;">2:00</div>
      <div id="top-round" style="font-size:10px;color:#aaa;margin-top:1px;"></div>
    </div>
    <div style="flex:1;">
      <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
        <span id="hp-my-text" style="color:#cce;">60/60</span>
        <span style="color:#88aaff;font-weight:700;">🏰 내 기지</span>
      </div>
      <div style="height:16px;background:#1a1a2e;border-radius:6px;overflow:hidden;position:relative;">
        <div id="bar-my" style="height:100%;width:100%;background:linear-gradient(90deg,#2255cc,#55aaff);border-radius:6px;transition:width 0.15s;position:absolute;right:0;"></div>
      </div>
    </div>
  </div>
  <!-- Currency slot bar -->
  <div style="display:flex;align-items:center;gap:6px;margin-top:5px;">
    <span style="font-size:12px;color:#ffd700;min-width:16px;">💰</span>
    <div id="currency-slots" style="display:flex;gap:3px;flex:1;"></div>
    <span id="currency-count" style="font-size:11px;color:#ffd700;min-width:32px;text-align:right;font-variant-numeric:tabular-nums;">0/15</span>
  </div>
</div>

<!-- BATTLE PANEL (bottom 50%) -->
<div id="panel-battle" style="position:fixed;bottom:0;left:0;right:0;height:50vh;display:none;z-index:10;background:rgba(8,14,30,0.92);border-top:2px solid rgba(255,255,255,0.12);">
  <!-- HUD top bar -->
  <div id="battle-hud" style="position:absolute;top:0;left:0;right:0;height:32px;background:rgba(0,0,0,0.4);display:flex;align-items:center;padding:0 12px;gap:16px;font-size:13px;">
    <span id="hud-currency">재화: 0 / 10</span>
    <span id="hud-round" style="color:#adf;"></span>
    <span id="hud-timer" style="color:#fda;"></span>
    <span id="hud-base" style="color:#fca;margin-left:auto;"></span>
    <button id="btn-cammode" style="padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#e8eefc;font-size:11px;cursor:pointer;">👁 시점</button>
  </div>
  <!-- Left: summon buttons -->
  <div id="panel-left" style="position:absolute;top:32px;left:0;width:50%;bottom:0;display:flex;flex-direction:column;padding:8px;gap:6px;">
    <div id="summon-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;overflow-y:auto;flex:1;align-content:start;padding-right:2px;"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
      <button id="btn-upgrade" style="flex:1;min-width:120px;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,200,80,0.5);background:rgba(255,200,80,0.12);color:#ffe08a;font-weight:700;cursor:pointer;font-size:12px;">기지 업그레이드</button>
      <span id="upgrade-info" style="font-size:10px;opacity:0.7;white-space:nowrap;min-width:40px;text-align:right;"></span>
      <button id="btn-heal-base" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(80,255,120,0.4);background:rgba(80,255,120,0.1);color:#a0ffb8;font-weight:700;cursor:pointer;font-size:12px;white-space:nowrap;">회복 (3재화)</button>
      <button id="btn-ballista" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(100,200,255,0.4);background:rgba(100,200,255,0.1);color:#aae4ff;font-weight:700;cursor:pointer;font-size:12px;white-space:nowrap;">발리스타 (10)</button>
      <button id="btn-catapult" style="padding:7px 10px;border-radius:8px;border:1px solid rgba(255,160,80,0.4);background:rgba(255,160,80,0.1);color:#ffc888;font-weight:700;cursor:pointer;font-size:12px;white-space:nowrap;">박격포 (10)</button>
    </div>
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
// ─── BGM ─────────────────────────────────────────────────────────────────────
const bgm = new Audio(`${import.meta.env.BASE_URL}bgm.mp3`);
bgm.loop = true;
bgm.volume = 0.4;

const battleBgm = new Audio(`${import.meta.env.BASE_URL}battle-bgm.mp3`);
battleBgm.loop = true;
battleBgm.volume = 0.45;

// ─── Sound Effects (Web Audio API) ───────────────────────────────────────────
let _actx: AudioContext | null = null;
const actx = () => { if (!_actx) _actx = new AudioContext(); if (_actx.state === 'suspended') _actx.resume(); return _actx; };

function sfx(type: 'click'|'spawn'|'attack'|'death'|'base_hit'|'food_launch'|'food_hit'|'victory'|'defeat'|'upgrade'|'card') {
  try {
    const ctx = actx(); const t = ctx.currentTime;
    const osc = (freq: number, type_: OscillatorType, start: number, dur: number, vol: number, freqEnd?: number) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = type_; o.frequency.setValueAtTime(freq, start);
      if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(freqEnd, start + dur);
      g.gain.setValueAtTime(vol, start); g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.start(start); o.stop(start + dur);
    };
    const noise = (start: number, dur: number, vol: number, lpFreq?: number, hpFreq?: number) => {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const s = ctx.createBufferSource(); const g = ctx.createGain(); s.buffer = buf;
      let node: AudioNode = s;
      if (lpFreq) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lpFreq; node.connect(f); node = f; }
      if (hpFreq) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hpFreq; node.connect(f); node = f; }
      node.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(vol, start); g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      s.start(start); s.stop(start + dur);
    };
    switch (type) {
      case 'click':       osc(900, 'sine', t, 0.07, 0.12); break;
      case 'card':        osc(600, 'sine', t, 0.05, 0.10); osc(900, 'sine', t+0.05, 0.07, 0.08); break;
      case 'spawn':       [0,0.07,0.13].forEach((dt,i) => osc(300*(1.5**i),'square',t+dt,0.07,0.07)); break;
      case 'attack':      noise(t, 0.08, 0.22, 500); break;
      case 'death':       osc(380, 'sawtooth', t, 0.4, 0.18, 70); noise(t, 0.15, 0.1, 200); break;
      case 'base_hit':    osc(90, 'sine', t, 0.5, 0.45, 35); noise(t, 0.2, 0.3, 300); break;
      case 'food_launch': noise(t, 0.22, 0.13, undefined, 400); osc(400,'sine',t,0.12,0.08,1200); break;
      case 'food_hit':    noise(t, 0.28, 0.38, 900); osc(120,'sine',t,0.2,0.2,40); break;
      case 'upgrade':     [0,0.1,0.2].forEach((dt,i) => osc([880,1108,1320][i],'sine',t+dt,0.28,0.14)); break;
      case 'victory':     [0,0.18,0.36,0.54].forEach((dt,i) => osc([523,659,784,1047][i],'sine',t+dt,0.45,0.22)); break;
      case 'defeat':      [0,0.22,0.44,0.66].forEach((dt,i) => osc([392,330,294,220][i],'sine',t+dt,0.5,0.18)); break;
    }
  } catch { /* ignore audio errors */ }
}

function showScreen(s: Screen) {
  currentScreen = s;
  const screens = ['initial','login','signup','loading','home','deck','shop','lobby2p','result','leaderboard'];
  for (const id of screens) $(`screen-${id}`).classList.toggle('hidden', s !== id);
  $('panel-battle').style.display = s === 'battle' ? 'block' : 'none';
  $('top-hud').style.display = s === 'battle' ? 'block' : 'none';
  renderer.domElement.style.display = s === 'battle' ? 'block' : 'none';
  if (s !== 'battle' && s !== 'initial') sfx('click');

  // BGM: 홈/로비엔 bgm, 전투 중엔 battleBgm
  if (s === 'battle') {
    bgm.pause();
    battleBgm.currentTime = 0;
    battleBgm.play().catch(() => {});
  } else {
    battleBgm.pause();
    battleBgm.currentTime = 0;
    bgm.play().catch(() => {}); // 브라우저 autoplay 정책 무시
  }

  // 2P 로비 진입 시 서버 wake-up ping (Render 무료 플랜 대비)
  if (s === 'lobby2p') {
    $('lobby-status').textContent = '서버 깨우는 중... (최대 60초)';
    const pingUrl = socketUrl.startsWith('http') ? socketUrl + '/health' : '/health';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 70000); // 70s timeout
    let dots = 0;
    const dotInterval = setInterval(() => {
      dots = (dots + 1) % 4;
      $('lobby-status').textContent = '서버 깨우는 중' + '.'.repeat(dots + 1) + ' (최대 60초)';
    }, 800);
    fetch(pingUrl, { signal: ctrl.signal })
      .then(r => r.json())
      .then(() => { clearTimeout(timer); clearInterval(dotInterval); $('lobby-status').textContent = '서버 준비 완료! 방 코드를 입력하세요'; })
      .catch(() => { clearTimeout(timer); clearInterval(dotInterval); $('lobby-status').textContent = '서버 응답 없음 — 그래도 입장 시도해보세요'; });
  }
}

function updateHomeDisplay() {
  ($('home-username') as HTMLElement).textContent = loggedInUsername || 'Guest';
  ($('home-gold') as HTMLElement).textContent = `${playerGold} G`;
}

showScreen('initial');
renderer.domElement.style.display = 'none';

// Pre-fill nickname from localStorage
const savedNick = localStorage.getItem('zoo_nickname') || '';
if (savedNick) ($('in-nickname') as HTMLInputElement).value = savedNick;

// ─── Deck Screen ──────────────────────────────────────────────────────────────
const DECK_MAX = 6;
let playerDeck: string[] = [...DEFAULT_DECK];
let playerOwnedAnimals: string[] = [...DEFAULT_DECK];

function buildDeckCards() {
  const container = $('deck-cards');
  container.innerHTML = '';

  const ownedAnimalIds = ANIMAL_IDS.filter(id => playerOwnedAnimals.includes(id));
  const ownedFoodIds   = FOOD_IDS.filter(id => playerOwnedAnimals.includes(id));

  if (ownedAnimalIds.length === 0 && ownedFoodIds.length === 0) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;opacity:0.55;padding:32px 0;font-size:14px;">
      보유한 캐릭터가 없습니다.<br>상점에서 상자를 열어 캐릭터를 획득하세요.
    </div>`;
    refreshDeckCards();
    return;
  }

  // Section header – Animals
  if (ownedAnimalIds.length > 0) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:700;color:#a0ffb8;letter-spacing:1px;margin-top:4px;';
    hdr.textContent = `캐릭터 (${ownedAnimalIds.length})`;
    container.appendChild(hdr);
    for (const id of ownedAnimalIds) {
      const d = ANIMALS[id];
      const card = document.createElement('div');
      card.dataset.id = id;
      card.style.cssText = [
        'padding:10px 8px;border-radius:12px;border:2px solid rgba(255,255,255,0.15);',
        'background:rgba(255,255,255,0.05);text-align:center;font-size:12px;cursor:pointer;',
        'transition:border-color 0.12s,background 0.12s;user-select:none;',
      ].join('');
      card.innerHTML = `
        <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;">${d.name}</div>
        <div style="margin-top:2px;font-size:10px;color:#88ccff;">${d.range > 2 ? '원거리' : '근거리'}</div>
        <div style="opacity:0.75;line-height:1.6;font-size:11px;">
          HP ${d.hp} / ATK ${d.atk}<br>
          SPD ${d.spd} / 비용 <b>${d.cost}</b>
        </div>`;
      card.addEventListener('click', () => { sfx('card'); toggleDeckCard(id); });
      container.appendChild(card);
    }
  }

  // Section header – Foods
  if (ownedFoodIds.length > 0) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:700;color:#ffd060;letter-spacing:1px;margin-top:10px;';
    hdr.textContent = `마법 아이템 (${ownedFoodIds.length})`;
    container.appendChild(hdr);
    for (const id of ownedFoodIds) {
      const f = FOODS[id];
      const card = document.createElement('div');
      card.dataset.id = id;
      card.style.cssText = [
        'padding:10px 8px;border-radius:12px;border:2px solid rgba(255,200,80,0.30);',
        'background:linear-gradient(180deg,rgba(60,30,5,0.55),rgba(20,10,2,0.55));text-align:center;font-size:12px;cursor:pointer;',
        'transition:border-color 0.12s,background 0.12s;user-select:none;position:relative;',
      ].join('');
      card.innerHTML = `
        <div style="position:absolute;top:4px;right:6px;font-size:9px;color:#ffd060;font-weight:700;letter-spacing:0.5px;">FOOD</div>
        <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;text-shadow:0 1px 2px rgba(0,0,0,0.7);">${f.name}</div>
        <div style="opacity:0.85;line-height:1.4;font-size:10px;color:#fff5dc;min-height:28px;">${f.desc}</div>
        <div style="margin-top:4px;font-size:11px;color:#ffd060;">비용 <b>${f.cost}</b></div>`;
      card.addEventListener('click', () => { sfx('card'); toggleDeckCard(id); });
      container.appendChild(card);
    }
  }

  // Unowned items section
  const allIds = [...ANIMAL_IDS, ...FOOD_IDS];
  const unownedIds = allIds.filter(id => !playerOwnedAnimals.includes(id));
  if (unownedIds.length > 0) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:700;color:#888;letter-spacing:1px;margin-top:14px;border-top:1px solid rgba(255,255,255,0.1);padding-top:10px;';
    hdr.textContent = `미획득 (${unownedIds.length})`;
    container.appendChild(hdr);
    const animalGrade = (id: string): string => {
      for (const g of ['A','B','C','D']) {
        if ((CHEST_POOLS[g] ?? []).includes(id)) return `${g}등급 상자`;
      }
      return '?';
    };
    for (const id of unownedIds) {
      const isFood = isFoodId(id);
      const def = isFood ? FOODS[id] : ANIMALS[id];
      if (!def) continue;
      const hex = `#${def.color.toString(16).padStart(6,'0')}`;
      const card = document.createElement('div');
      card.style.cssText = 'padding:8px 6px;border-radius:12px;border:2px solid rgba(255,255,255,0.08);background:rgba(0,0,0,0.3);text-align:center;font-size:11px;opacity:0.6;position:relative;';
      const atkType = !isFood ? `<div style="font-size:9px;color:#88ccff;">${(def as AnimalDef).range > 2 ? '원거리' : '근거리'}</div>` : `<div style="font-size:9px;color:#ffd060;">FOOD</div>`;
      card.innerHTML = `
        <div style="width:8px;height:8px;border-radius:50%;background:${hex};margin:0 auto 4px;"></div>
        <div style="font-size:12px;font-weight:700;color:#ccc;margin-bottom:2px;">${def.name}</div>
        ${atkType}
        <div style="font-size:9px;color:#ffd060;margin-top:3px;">${animalGrade(id)}</div>
      `;
      container.appendChild(card);
    }
  }

  refreshDeckCards();
}

function toggleDeckCard(id: string) {
  console.log('[deck] toggleDeckCard', id, 'deck=', [...playerDeck]);
  const idx = playerDeck.indexOf(id);
  if (idx >= 0) {
    playerDeck.splice(idx, 1);
  } else {
    if (playerDeck.length >= DECK_MAX) { console.log('[deck] at max, skip'); return; }
    playerDeck.push(id);
  }
  console.log('[deck] after toggle deck=', [...playerDeck]);
  refreshDeckCards();
}

function refreshDeckCards() {
  const container = $('deck-cards');
  const atMax = playerDeck.length >= DECK_MAX;
  for (const card of Array.from(container.children) as HTMLElement[]) {
    const id = card.dataset.id!;
    const selected = playerDeck.includes(id);
    const dimmed = !selected && atMax;
    card.style.borderColor = selected ? '#41c1ff' : 'rgba(255,255,255,0.15)';
    card.style.background = selected
      ? 'rgba(65,193,255,0.18)'
      : dimmed
        ? 'rgba(255,255,255,0.02)'
        : 'rgba(255,255,255,0.05)';
    card.style.opacity = dimmed ? '0.35' : '1';
    card.style.cursor = dimmed ? 'not-allowed' : 'pointer';
  }
  $('deck-count').textContent = `${playerDeck.length} / ${DECK_MAX} 선택`;
}

// ─── Summon Buttons ───────────────────────────────────────────────────────────
const summonBtns: HTMLButtonElement[] = [];

function buildSummonButtons() {
  const grid = $('summon-grid');
  grid.innerHTML = '';
  summonBtns.length = 0;
  const deck = playerDeck.length > 0 ? playerDeck : ANIMAL_IDS.slice(0, DECK_MAX);
  const hotkeys = ['Q','W','E','A','S','D'];
  for (let i = 0; i < deck.length; i++) {
    const id = deck[i];
    const isFood = isFoodId(id);
    const def: { name: string; cost: number } = isFood ? FOODS[id] : ANIMALS[id];
    const btn = document.createElement('button');
    btn.dataset.id = id;
    btn.dataset.kind = isFood ? 'food' : 'animal';
    const keyBadge = `<span style="display:block;font-size:9px;color:rgba(255,255,255,0.5);margin-bottom:1px;">${hotkeys[i] ?? ''}</span>`;
    if (isFood) {
      btn.style.cssText = 'border-radius:10px;border:1px solid rgba(255,200,80,0.4);background:linear-gradient(180deg,rgba(80,40,5,0.50),rgba(40,20,2,0.50));color:#fff5dc;font-weight:700;cursor:pointer;font-size:12px;padding:4px 2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;';
      btn.innerHTML = `${keyBadge}<span style="font-size:14px;color:#fff">${def.name}</span><span style="opacity:0.85;font-size:11px;color:#ffd060;">비용 ${def.cost}</span>`;
    } else {
      btn.style.cssText = 'border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);color:#e8eefc;font-weight:700;cursor:pointer;font-size:12px;padding:4px 2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;';
      btn.innerHTML = `${keyBadge}<span style="font-size:14px;color:#fff">${def.name}</span><span style="opacity:0.8;font-size:11px;">비용 ${def.cost}</span>`;
    }
    btn.addEventListener('click', () => {
      if (isFood) playerUseFood(id);
      else playerSummon(id);
    });
    grid.appendChild(btn);
    summonBtns.push(btn);
  }
}

function updateSummonButtons() {
  for (const btn of summonBtns) {
    const id = btn.dataset.id!;
    const cost = isFoodId(id) ? FOODS[id].cost : ANIMALS[id].cost;
    const canAfford = currency >= cost;
    btn.style.opacity = canAfford ? '1' : '0.4';
    btn.style.cursor = canAfford ? 'pointer' : 'not-allowed';
  }
}

function applyTeamTheme() {
  const panel = $('panel-battle') as HTMLElement;
  const btnUp = $('btn-upgrade') as HTMLButtonElement;
  const barMy = $('bar-my') as HTMLElement;
  const barFoe = $('bar-foe') as HTMLElement;
  if (myTeam === 'red') {
    panel.style.background = 'rgba(30,8,8,0.95)';
    panel.style.borderTopColor = 'rgba(255,100,100,0.25)';
    btnUp.style.background = 'rgba(255,120,80,0.15)';
    btnUp.style.borderColor = 'rgba(255,120,80,0.5)';
    btnUp.style.color = '#ffcc88';
    barMy.style.background = 'linear-gradient(90deg,#cc2222,#ff5555)';
  } else {
    panel.style.background = 'rgba(15,8,30,0.95)';
    panel.style.borderTopColor = 'rgba(180,100,255,0.25)';
    btnUp.style.background = 'rgba(180,120,255,0.15)';
    btnUp.style.borderColor = 'rgba(180,120,255,0.5)';
    btnUp.style.color = '#d0a0ff';
    barMy.style.background = 'linear-gradient(90deg,#6622cc,#aa55ff)';
  }
  // foe bar reflects opponent's team
  barFoe.style.background = foeTeam === 'red'
    ? 'linear-gradient(90deg,#ff5555,#cc2222)'
    : 'linear-gradient(90deg,#aa55ff,#6622cc)';
  // summon buttons
  for (const btn of summonBtns) {
    if (myTeam === 'red') {
      btn.style.background = 'rgba(160,30,30,0.25)';
      btn.style.borderColor = 'rgba(255,120,120,0.3)';
    } else {
      btn.style.background = 'rgba(90,20,160,0.25)';
      btn.style.borderColor = 'rgba(180,120,255,0.3)';
    }
  }
}

function updateUpgradeButton() {
  const myLevel = localSide === 'p1' ? p1TowerLevel : p2TowerLevel;
  const btn = $('btn-upgrade') as HTMLButtonElement;
  const info = $('upgrade-info');
  if (myLevel >= 2) {
    btn.textContent = '기지 최대 레벨';
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    info.textContent = 'MAX';
  } else {
    const cost = UPGRADE_COSTS[myLevel];
    btn.textContent = `업그레이드 (${cost}재화)`;
    btn.style.opacity = currency >= cost ? '1' : '0.4';
    btn.style.cursor = currency >= cost ? 'pointer' : 'not-allowed';
    info.textContent = `Lv${myLevel + 1}→${myLevel + 2}`;
  }
}

function upgradeBase() {
  if (!battleActive) return;
  const myLevel = localSide === 'p1' ? p1TowerLevel : p2TowerLevel;
  if (myLevel >= 2) return;
  const cost = UPGRADE_COSTS[myLevel];
  if (currency < cost) return;
  currency -= cost;
  if (gameMode === '1p') {
    p1TowerLevel++;
    sfx('upgrade');
    const myBase = localSide === 'p1' ? p1Base : p2Base;
    myBase.maxHp += HP_PER_UPGRADE;
    myBase.hp = Math.min(myBase.maxHp, myBase.hp + HP_PER_UPGRADE);
    myBase.lastHp = -1;
    p1TowerLastStage = -1;
    updateTowerVisual('p1');
  } else {
    socket.emit('battleUpgrade');
  }
  updateHud();
}

function playerSummon(animalId: string) {
  if (!battleActive) return;
  const cost = ANIMALS[animalId].cost;
  if (currency < cost) return;
  currency -= cost;
  updateHud();
  if (gameMode === '1p') {
    const count = ANIMALS[animalId].groupSpawn ?? 1;
    for (let i = 0; i < count; i++) spawnUnit(animalId, localSide);
    sfx('spawn');
  } else {
    socket.emit('battleSpawn', { animalId }); // single emit — server handles groupSpawn
    sfx('spawn');
  }
}

function playerUseFood(foodId: string) {
  if (!battleActive) return;
  const def = FOODS[foodId];
  if (!def) return;
  if (currency < def.cost) return;
  // Broccoli is unique: only one barrier allowed at a time
  if (def.effect === 'broccoli_barrier' && broccoliActive(localSide)) return;
  currency -= def.cost;
  updateHud();
  if (gameMode === '1p') {
    triggerFoodEffect(foodId, localSide);
    sfx('food_launch');
  } else {
    socket.emit('battleSpawn', { animalId: foodId }); // network: reuse animal channel
    sfx('food_launch');
  }
}

($('btn-upgrade') as HTMLButtonElement).addEventListener('click', upgradeBase);
($('btn-ballista') as HTMLButtonElement).addEventListener('click', () => buySiege('ballista'));
($('btn-catapult') as HTMLButtonElement).addEventListener('click', () => buySiege('catapult'));
($('btn-heal-base') as HTMLButtonElement).addEventListener('click', () => {
  if (!battleActive) return;
  if (currency < BASE_HEAL_COST) return;
  const myBase = localSide === 'p1' ? p1Base : p2Base;
  if (!myBase) return;
  if (myBase.hp >= myBase.maxHp) { showQuizMsg('기지 체력이 이미 최대입니다'); return; }
  currency -= BASE_HEAL_COST;
  myBase.hp = Math.min(myBase.maxHp, myBase.hp + BASE_HEAL_AMOUNT);
  myBase.lastHp = -1; // force HP bar redraw
  updateHud();
});

$('btn-cammode').addEventListener('click', () => {
  camMode = camMode === 'side' ? 'top' : 'side';
  ($('btn-cammode') as HTMLButtonElement).textContent = camMode === 'top' ? '👁 측면' : '👁 시점';
});

// ─── Battle Init ──────────────────────────────────────────────────────────────
function clearBattle() {
  for (const u of [...units]) removeUnitMeshes(u);
  units = [];
  p1MonstersKilled = 0;
  p1BossesKilled = 0;
  p1DragonKilled = false;
  correctWords = [];
  wrongWords = 0;
  spamWrongLog = [];
  spamLockUntil = 0;
  if (p1Base) { scene.remove(p1Base.mesh); scene.remove(p1Base.hpSprite); }
  if (p2Base) { scene.remove(p2Base.mesh); scene.remove(p2Base.hpSprite); }
  for (const m of baseTowerMeshes) scene.remove(m);
  baseTowerMeshes.length = 0;
  p1TowerMesh = null;
  p2TowerMesh = null;
  p1TowerLevel = 0;
  p2TowerLevel = 0;
  p1TowerLastStage = -1;
  p2TowerLastStage = -1;
  p1Team = 'red';
  p2Team = 'violet';
  clearSiegeWeapons();
  clearFoodEffects();
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
  battleClock = 0;
  currency = 0;
  autoCurrencyTimer = 0;
  quizEventTriggerTimer = 60;
  quizEventActive = false;
  $('quiz-event-overlay').style.display = 'none';
  camPan = 0;
  camMode = 'side';
  ($('btn-cammode') as HTMLButtonElement).textContent = '👁 시점';
  round = 1;
  roundTimer = ROUND_DURATION;
  aiSpawnTimer = AI_ROUNDS[0].interval;
  unitIdCounter = 0;

  // Assign teams (1P: random; 2P: set by battleStart handler before calling startBattle)
  if (gameMode === '1p') {
    myTeam = Math.random() < 0.5 ? 'red' : 'violet';
    foeTeam = myTeam === 'red' ? 'violet' : 'red';
  }
  p1Team = localSide === 'p1' ? myTeam : foeTeam;
  p2Team = localSide === 'p1' ? foeTeam : myTeam;

  const teamColor = (t: Team) => t === 'red' ? 0xcc2233 : 0x7722bb;
  const enemyBaseHp = gameMode === '1p' ? BASE_HP_1P_ENEMY : BASE_HP;
  p1Base = makeBase(2, teamColor(p1Team), BASE_HP);
  p2Base = makeBase(FIELD_LEN - 2, teamColor(p2Team), enemyBaseHp);
  placeBaseTowers();

  if (gameMode === '1p') {
    // 적 타워 최대 레벨로 시작
    p2TowerLevel = 2;
    updateTowerVisual('p2');
    // 보스 초기화 + 모델 로딩
    resetBossSpawned();
    loadBossModels();
    loadMonsterModels();
  }
  loadFoodModels();

  multiplayerTimeLeft = 120;

  buildSummonButtons();
  applyTeamTheme();
  pickNewWord();
  updateHud();
  showScreen('battle');
  updateCamera();
}

// ─── Camera Update ────────────────────────────────────────────────────────────
function updateCamera(dt = 0) {
  if (camMode === 'top') {
    // Bird's-eye: straight down over field center, field appears horizontal
    // camera.up X-axis → Z-axis runs left-right on screen
    // p1 base (z=SPAWN_P1, small) on right → up = (-1,0,0)
    // p2 base (z=SPAWN_P2, large) on right → up = (+1,0,0)
    camera.fov = 72;
    camera.updateProjectionMatrix();
    camera.up.set(localSide === 'p1' ? -1 : 1, 0, 0);
    const midZ = (SPAWN_P1 + SPAWN_P2) / 2;
    camera.position.set(0, 38, midZ);
    camera.lookAt(0, 0, midZ);
    return;
  }

  // Restore side-view camera settings
  if (camera.up.y !== 1) camera.up.set(0, 1, 0);

  // Portrait mode: wider FOV so more of the field fits on screen
  const isPortrait = window.innerHeight > window.innerWidth;
  const targetFov = isPortrait ? 80 : 65;
  if (camera.fov !== targetFov) { camera.fov = targetFov; camera.updateProjectionMatrix(); }

  // Pan limits: generous forward (enemy side) range, tighter backward range
  // P1 moves +Z toward enemy; P2 moves -Z toward enemy
  const panFwd  = isPortrait ? 30 : 26;  // toward enemy (more room needed on portrait)
  const panBack = isPortrait ? 12 : 10;  // toward own base
  const panMin = localSide === 'p1' ? -panBack : -panFwd;
  const panMax = localSide === 'p1' ?  panFwd  :  panBack;

  // Inertia: continue sliding after release, decay with friction
  if (!camPanActive && Math.abs(camPanVel) > 0.01) {
    camPan = Math.max(panMin, Math.min(panMax, camPan + camPanVel * dt));
    camPanVel *= Math.max(0, 1 - 9 * dt);
  } else if (!camPanActive) {
    camPanVel = 0;
  }
  camPan = Math.max(panMin, Math.min(panMax, camPan));

  const baseZ = localSide === 'p1' ? FIELD_LEN * 0.33 : FIELD_LEN * 0.67;
  const lookZ = baseZ + camPan;
  const camH = isPortrait ? 7 : 5;
  if (localSide === 'p1') {
    camera.position.set(8, camH, lookZ);
    camera.lookAt(0, 3, lookZ);
  } else {
    camera.position.set(-8, camH, lookZ);
    camera.lookAt(0, 3, lookZ);
  }
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────
function renderLeaderboard(entries: LeaderboardEntry[], tab: 'words' | 'clear') {
  const list = $('lb-list');
  if (!entries.length) { list.innerHTML = '<div style="text-align:center;color:#aaa;padding:20px;">아직 기록이 없어요</div>'; ($('btn-lb-delete') as HTMLElement).style.display = 'none'; return; }
  const myNick = loggedInUsername || guestNickname;
  const hasMyRecord = entries.some(e => e.nickname === myNick);
  ($('btn-lb-delete') as HTMLElement).style.display = hasMyRecord ? 'block' : 'none';
  list.innerHTML = entries.map((e, i) => {
    const isMe = e.nickname === myNick;
    const rank = i + 1;
    const rankLabel = rank <= 3 ? ['1위', '2위', '3위'][rank - 1] : `${rank}위`;
    const accuracy = (e.total_words ?? 0) > 0 ? Math.round((e.word_count / e.total_words) * 100) : 100;
    const val = tab === 'words'
      ? `${e.word_count}개 (정답률 ${accuracy}%)`
      : `${e.clear_count}회${e.best_time ? ` · 최단 ${fmtTime(e.best_time)}` : ''}${e.rounds_completed ? ` · ${e.rounds_completed}라운드` : ''}`;
    const rankColor = rank === 1 ? '#ffd700' : rank === 2 ? '#c0c0c0' : rank === 3 ? '#cd7f32' : '#aaa';
    return `<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;background:${isMe ? 'rgba(255,215,0,0.15)' : 'rgba(255,255,255,0.04)'};border:1px solid ${isMe ? 'rgba(255,215,0,0.4)' : 'rgba(255,255,255,0.07)'};">
      <span style="min-width:34px;font-size:13px;font-weight:700;color:${rankColor};">${rankLabel}</span>
      <span style="flex:1;font-weight:${isMe ? '700' : '400'};color:${isMe ? '#ffd700' : '#e8eefc'};">${e.nickname}</span>
      <span style="color:#a0ffb8;font-size:13px;">${val}</span>
    </div>`;
  }).join('');
}

async function loadLeaderboard(tab: 'words' | 'clear') {
  lbTab = tab;
  // Update tab button styles
  ($('lb-tab-words') as HTMLButtonElement).className = `btn ${tab === 'words' ? 'primary' : ''}`;
  ($('lb-tab-words') as HTMLButtonElement).style.cssText = `flex:1;padding:10px;font-size:14px;`;
  ($('lb-tab-clear') as HTMLButtonElement).className = `btn ${tab === 'clear' ? 'primary' : ''}`;
  ($('lb-tab-clear') as HTMLButtonElement).style.cssText = `flex:1;padding:10px;font-size:14px;`;
  $('lb-status').textContent = '불러오는 중...';
  const sortBy = tab === 'words' ? 'word_count' : 'clear_count';
  const entries = await fetchLeaderboard(sortBy);
  renderLeaderboard(entries, tab);
  $('lb-status').textContent = `최근 갱신: ${new Date().toLocaleTimeString('ko-KR')} · 상위 100명`;
}

// ─── Currency Slots Init ──────────────────────────────────────────────────────
const currencySlotEls: HTMLElement[] = [];
(function initCurrencySlots() {
  const container = $('currency-slots');
  for (let i = 0; i < CURRENCY_MAX; i++) {
    const slot = document.createElement('div');
    slot.style.cssText = 'flex:1;height:10px;border-radius:3px;background:#1a1a2e;border:1px solid rgba(255,215,0,0.2);transition:background 0.08s,transform 0.08s;';
    container.appendChild(slot);
    currencySlotEls.push(slot);
  }
})();

// ─── HUD ──────────────────────────────────────────────────────────────────────
function updateHud() {
  $('hud-currency').textContent = `재화: ${currency} / ${CURRENCY_MAX}`;
  // Currency slot bar
  for (let i = 0; i < CURRENCY_MAX; i++) {
    const filled = i < currency;
    currencySlotEls[i].style.background = filled ? 'linear-gradient(180deg,#ffe066,#f5a800)' : '#1a1a2e';
    currencySlotEls[i].style.borderColor = filled ? 'rgba(255,215,0,0.7)' : 'rgba(255,215,0,0.2)';
    currencySlotEls[i].style.transform = filled ? 'scaleY(1.15)' : 'scaleY(1)';
    currencySlotEls[i].style.boxShadow = filled ? '0 0 4px rgba(255,200,0,0.5)' : 'none';
  }
  $('currency-count').textContent = `${currency}/${CURRENCY_MAX}`;
  updateSummonButtons();
  updateUpgradeButton();
  updateSiegeButtons();

  // Top HUD HP bars — my base always on right, foe on left
  if (p1Base && p2Base) {
    const myBase  = localSide === 'p1' ? p1Base : p2Base;
    const foeBase = localSide === 'p1' ? p2Base : p1Base;
    ($('bar-my') as HTMLElement).style.width  = `${Math.max(0, myBase.hp  / myBase.maxHp  * 100)}%`;
    ($('bar-foe') as HTMLElement).style.width = `${Math.max(0, foeBase.hp / foeBase.maxHp * 100)}%`;
    $('hp-my-text').textContent  = `${Math.ceil(myBase.hp)}/${myBase.maxHp}`;
    $('hp-foe-text').textContent = `${Math.ceil(foeBase.hp)}/${foeBase.maxHp}`;
    const myBase2 = myBase;
    $('hud-base').textContent = `내 기지 ${Math.ceil(myBase2.hp)} / ${myBase2.maxHp}`;
  }

  // Timer & round
  if (gameMode === '1p') {
    $('top-round').textContent = `라운드 ${round}/${AI_ROUNDS.length}`;
    $('top-timer').textContent = fmtTime(roundTimer);
    $('hud-round').textContent = `라운드 ${round}/${AI_ROUNDS.length}`;
    $('hud-timer').textContent = `${Math.ceil(roundTimer)}초`;
  } else {
    $('top-round').textContent = '2인 대전';
    $('top-timer').textContent = fmtTime(multiplayerTimeLeft);
  }
}

// ─── 1P AI ───────────────────────────────────────────────────────────────────
function checkBossThresholds() {
  if (!p2Base) return;
  const hp = p2Base.hp;
  for (const { hp: threshold, bossId } of BOSS_THRESHOLDS) {
    if (!bossSpawned[bossId] && hp <= threshold) {
      console.log(`[Boss] threshold triggered! p2Base.hp=${hp} <= ${threshold}, spawning ${bossId}`);
      bossSpawned[bossId] = true;
      spawnBoss(bossId);
      // 보스 등장 이펙트 + 적 기지 주변 p1 유닛에 20 데미지 (공중/지상 모두)
      triggerBossSpawnEffect(p2Base.z);
      const SPAWN_BLAST_RADIUS = 16;
      for (const u of units) {
        if (u.side === 'p1' && u.state !== 'dead' && Math.abs(u.z - p2Base.z) <= SPAWN_BLAST_RADIUS) {
          u.hp = Math.max(0, u.hp - 20);
          if (u.hp <= 0) u.state = 'dead';
        }
      }
      // 드래곤 등장 시 적 기지 옆에 발리스타 + 박격포 설치
      if (bossId === 'dragon') {
        placeSiege('ballista', 'p2');
        placeSiege('catapult', 'p2');
      }
    }
  }
}

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
    // advance to next round (no win by timer — only base destruction wins)
    if (round < AI_ROUNDS.length) round++;
    roundTimer = ROUND_DURATION;
    aiSpawnTimer = AI_ROUNDS[Math.min(round - 1, AI_ROUNDS.length - 1)].interval;
  }

  checkBossThresholds();
}

function checkWinLose() {
  if (!battleActive) return;
  if (p1Base.hp <= 0) { endBattle('lose'); return; }
  if (p2Base.hp <= 0) { endBattle('win'); return; }
}

function endBattle(result: 'win' | 'lose' | 'draw') {
  battleActive = false;
  if (result === 'win') sfx('victory');
  else if (result === 'lose') sfx('defeat');
  const B = import.meta.env.BASE_URL;
  const isWin = result !== 'lose';
  const resScreen = $('screen-result');
  resScreen.style.backgroundImage = `url('${B}ui/PNG/${isWin ? 'you_win' : 'you_lose'}/bg.png')`;
  resScreen.style.backgroundSize = 'cover';
  resScreen.style.backgroundPosition = 'center';
  ($('result-header-img') as HTMLImageElement).src = `${B}ui/PNG/${isWin ? 'you_win' : 'you_lose'}/header.png`;

  // Gold breakdown (1P only)
  const statsEl = $('result-stats') as HTMLElement;
  const wordsEl = $('result-words') as HTMLElement;

  if (gameMode === '1p') {
    const GOLD_PER_MONSTER = 1;
    const GOLD_PER_BOSS = 5;
    const GOLD_DRAGON_BONUS = 10;
    const GOLD_PER_ROUND = 2;
    const GOLD_WIN_BONUS = 20;
    const gMonster = p1MonstersKilled * GOLD_PER_MONSTER;
    const gBoss = p1BossesKilled * GOLD_PER_BOSS;
    const gDragon = p1DragonKilled ? GOLD_DRAGON_BONUS : 0;
    const gRound = round * GOLD_PER_ROUND;
    const gWin = result === 'win' ? GOLD_WIN_BONUS : 0;
    const gTotal = gMonster + gBoss + gDragon + gRound + gWin;
    playerGold += gTotal;

    // Submit leaderboard
    // NOTE: Run this SQL in Supabase Dashboard > SQL Editor:
    // ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS wrong_count INTEGER DEFAULT 0;
    // ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS total_words INTEGER DEFAULT 0;
    // ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS rounds_completed INTEGER DEFAULT 0;
    const nick = loggedInUsername || guestNickname;
    if (nick) {
      const totalAttempted = correctWords.length + wrongWords;
      submitLeaderboard(nick, correctWords.length, result === 'win', result === 'win' ? battleClock : null, wrongWords, totalAttempted, round);
    }

    const row = (label: string, val: string) =>
      `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
        <span style="opacity:0.85;">${label}</span><span style="color:#ffd060;font-weight:700;">${val}</span>
      </div>`;

    statsEl.style.display = 'block';
    statsEl.innerHTML = `
      <div style="background:rgba(10,25,6,0.82);border:1px solid rgba(80,200,60,0.3);border-radius:14px;padding:14px 18px;font-size:14px;">
        <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#a0ffb8;">골드 획득 내역</div>
        ${row(`몬스터 처치 (${p1MonstersKilled}마리 × ${GOLD_PER_MONSTER}G)`, `${gMonster}G`)}
        ${row(`보스 처치 (${p1BossesKilled}마리 × ${GOLD_PER_BOSS}G)`, `${gBoss}G`)}
        ${p1DragonKilled ? row('드래곤 처치 보너스', `+${gDragon}G`) : ''}
        ${row(`생존 라운드 (${round}라운드 × ${GOLD_PER_ROUND}G)`, `${gRound}G`)}
        ${gWin > 0 ? row('클리어 보너스', `+${gWin}G`) : ''}
        <div style="display:flex;justify-content:space-between;padding:8px 0 2px;font-size:16px;font-weight:900;">
          <span>합계</span><span style="color:#ffd060;">+${gTotal}G</span>
        </div>
      </div>`;
  } else {
    statsEl.style.display = 'none';
  }

  // Correct words
  if (correctWords.length > 0) {
    wordsEl.style.display = 'block';
    const rows = correctWords.map(w =>
      `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.07);font-size:13px;">
        <span style="color:#a8e6ff;font-weight:700;min-width:110px;">${w.en}</span>
        <span style="opacity:0.8;">${w.ko}</span>
      </div>`
    ).join('');
    wordsEl.innerHTML = `
      <div style="background:rgba(10,25,6,0.82);border:1px solid rgba(80,200,60,0.3);border-radius:14px;padding:14px 18px;">
        <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#a0ffb8;">맞춘 단어 (${correctWords.length}개)</div>
        ${rows}
      </div>`;
  } else {
    wordsEl.style.display = 'none';
  }

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
  if (spamLockUntil > 0 && battleClock < spamLockUntil) return;
  if (idx === correctIdx) {
    addCurrency(CURRENCY_MC);
    correctWords.push({ en: currentWord.english, ko: currentWord.korean });
    pickNewWord();
  } else {
    wrongWords++;
    addCurrency(-1);
    showQuizMsg('틀렸습니다 (-1)');
    spamWrongLog.push(battleClock);
    spamWrongLog = spamWrongLog.filter(t => battleClock - t < 8);
    if (spamWrongLog.length >= 4) {
      spamLockUntil = battleClock + 2;
      spamWrongLog = [];
      $('choices').style.visibility = 'hidden';
      ($('type-input') as HTMLInputElement).disabled = true;
      showQuizMsg('연속 오답 - 2초 대기');
    }
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

let _compositionEnded = false;
($('type-input') as HTMLInputElement).addEventListener('compositionend', () => { _compositionEnded = true; });
($('type-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Escape') { exitTypingMode(); return; }
  if (e.code !== 'Enter') return;
  if (e.isComposing && !_compositionEnded) return;
  _compositionEnded = false;
  if (spamLockUntil > 0 && battleClock < spamLockUntil) return;
  const typed = (e.target as HTMLInputElement).value.trim();
  if (!typed) return;
  const correct = currentWord.answers.some(a => a.trim() === typed || a.trim().replace(/\s/g,'') === typed.replace(/\s/g,''));
  if (correct) {
    addCurrency(CURRENCY_TYPE);
    correctWords.push({ en: currentWord.english, ko: currentWord.korean });
    pickNewWord();
    (e.target as HTMLInputElement).value = '';
    (e.target as HTMLInputElement).focus();
  } else {
    wrongWords++;
    addCurrency(-1);
    showQuizMsg('틀렸습니다 (-1)');
    spamWrongLog.push(battleClock);
    spamWrongLog = spamWrongLog.filter(t => battleClock - t < 8);
    if (spamWrongLog.length >= 4) {
      spamLockUntil = battleClock + 2;
      spamWrongLog = [];
      $('choices').style.visibility = 'hidden';
      ($('type-input') as HTMLInputElement).disabled = true;
      showQuizMsg('연속 오답 - 2초 대기');
    }
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
  if (gameMode === '2p' && amt > 0 && battleActive) {
    socket.emit('currencyEarn', { amount: amt });
  }
}

// ─── Quiz Event (every 60s) ───────────────────────────────────────────────────
function startQuizEvent() {
  quizEventActive = true;
  quizEventAnswered = false;
  // Pick 5 random words
  const shuffled = [...wordList].sort(() => Math.random() - 0.5);
  quizEventWords = shuffled.slice(0, 5);
  quizEventPhase = 'study';
  quizEventPhaseTimer = 5;

  const overlay = $('quiz-event-overlay');
  overlay.style.display = 'flex';
  $('qe-study').style.display = 'block';
  $('qe-quiz').style.display = 'none';
  ($('qe-result') as HTMLElement).style.display = 'none';
  $('qe-title').textContent = '단어 암기! (5초)';
  $('qe-word-list').innerHTML = quizEventWords.map(w =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.08);gap:12px;">
      <span style="color:#7ad7f0;font-weight:700;font-size:16px;">${w.english}</span>
      <span style="color:#ffe0a0;font-size:14px;">${w.korean.split(',')[0].trim()}</span>
    </div>`
  ).join('');
  $('qe-timer-fill').style.width = '100%';
}

function advanceQuizEventToQuiz() {
  quizEventPhase = 'quiz';
  quizEventPhaseTimer = 5;
  // Pick 1 of the 5 as the question
  quizEventQuestion = quizEventWords[Math.floor(Math.random() * 5)];
  // Choices: short Korean meanings of all 5 words, shuffled
  quizEventChoices = quizEventWords.map(w => w.korean.split(',')[0].trim());
  for (let i = quizEventChoices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [quizEventChoices[i], quizEventChoices[j]] = [quizEventChoices[j], quizEventChoices[i]];
  }
  $('qe-study').style.display = 'none';
  $('qe-quiz').style.display = 'block';
  $('qe-title').textContent = '문제를 맞춰라!';
  $('qe-question').textContent = quizEventQuestion.english;
  const cont = $('qe-choices');
  cont.innerHTML = '';
  quizEventChoices.forEach((choice, i) => {
    const btn = document.createElement('button');
    btn.textContent = `${i + 1}. ${choice}`;
    btn.style.cssText = 'padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);color:#e8eefc;font-size:14px;cursor:pointer;text-align:left;transition:background 0.15s;';
    btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(255,255,255,0.15)'; });
    btn.addEventListener('mouseout', () => { btn.style.background = 'rgba(255,255,255,0.07)'; });
    btn.addEventListener('click', () => submitQuizEventChoice(i));
    cont.appendChild(btn);
  });
  $('qe-timer-fill').style.width = '100%';
}

function submitQuizEventChoice(idx: number) {
  if (quizEventAnswered) return;
  quizEventAnswered = true;
  const correctMeaning = quizEventQuestion!.korean.split(',')[0].trim();
  const correct = quizEventChoices[idx] === correctMeaning;
  $('qe-quiz').style.display = 'none';
  const res = $('qe-result') as HTMLElement;
  res.style.display = 'flex';
  if (correct) {
    res.innerHTML = '정답!<br><span style="font-size:16px;color:#a0ffb8;">+15 재화 지급</span>';
    addCurrency(15);
  } else {
    res.innerHTML = `오답<br><span style="font-size:14px;color:#ffb0b0;">정답: ${correctMeaning}</span>`;
  }
  setTimeout(() => endQuizEvent(), 2000);
}

function endQuizEvent() {
  quizEventActive = false;
  $('quiz-event-overlay').style.display = 'none';
}

// Keyboard shortcuts for quiz + summon hotkeys
window.addEventListener('keydown', (e) => {
  if (currentScreen !== 'battle') return;
  if (e.code === 'KeyT') { enterTypingMode(); return; }
  if (isTypingMode) return;
  if (e.code === 'Digit1') submitChoice(0);
  else if (e.code === 'Digit2') submitChoice(1);
  else if (e.code === 'Digit3') submitChoice(2);

  // Summon hotkeys Q,W,E,A,S,D
  if (!isTypingMode && currentScreen === 'battle' && battleActive) {
    const SUMMON_KEYS: Record<string, number> = { KeyQ:0, KeyW:1, KeyE:2, KeyA:3, KeyS:4, KeyD:5 };
    const idx = SUMMON_KEYS[e.code];
    if (idx !== undefined && idx < playerDeck.length) {
      const id = playerDeck[idx];
      if (isFoodId(id)) playerUseFood(id);
      else playerSummon(id);
    }
  }
});

// ─── 2P Socket Setup ──────────────────────────────────────────────────────────
socket.on('connect', () => {
  $('lobby-status').textContent = '서버 연결됨';
  // flush pending battleJoin if queued before connection
  const pending = (socket as any).__pendingJoin;
  if (pending) { delete (socket as any).__pendingJoin; socket.emit('battleJoin', pending); }
});
socket.on('connect_error', (err) => {
  $('lobby-status').textContent = `서버 연결 실패: ${err.message}`;
});
socket.on('disconnect', () => {
  if (currentScreen === 'battle') endBattle('lose');
});
socket.on('waitingForOpponent', () => {
  $('lobby-status').textContent = '상대방을 기다리는 중...';
});
socket.on('joinError', (msg: string) => { $('lobby-status').textContent = `오류: ${msg}`; });

socket.on('battleStart', (payload: { side: Side; opponentNick: string; myTeam?: Team; foeTeam?: Team }) => {
  localSide = payload.side;
  if (payload.myTeam)  myTeam  = payload.myTeam;
  if (payload.foeTeam) foeTeam = payload.foeTeam;
  startBattle();
});

socket.on('opponentLeft', () => {
  if (currentScreen === 'battle') endBattle('win');
  else $('lobby-status').textContent = '상대방이 나갔습니다';
});

// Server sends authoritative game state every 50ms
socket.on('gameState', (payload: {
  units: Array<{ id: string; animalId: string; side: Side; z: number; x: number; hp: number; maxHp: number; state: UnitState; stingerReady?: boolean; paralyzedUntil?: number }>;
  p1BaseHp: number; p2BaseHp: number; p1MaxHp?: number; p2MaxHp?: number;
  p1UpgradeLevel?: number; p2UpgradeLevel?: number; timeLeft?: number;
  p1Currency?: number; p2Currency?: number;
  siegeState?: Record<string, { x: number; z: number } | null>;
}) => {
  if (!battleActive) return;

  if (typeof payload.p1BaseHp === 'number') p1Base.hp = payload.p1BaseHp;
  if (typeof payload.p2BaseHp === 'number') p2Base.hp = payload.p2BaseHp;
  if (typeof payload.p1MaxHp === 'number') p1Base.maxHp = payload.p1MaxHp;
  if (typeof payload.p2MaxHp === 'number') p2Base.maxHp = payload.p2MaxHp;
  if (typeof payload.p1UpgradeLevel === 'number' && payload.p1UpgradeLevel !== p1TowerLevel) {
    p1TowerLevel = payload.p1UpgradeLevel; p1TowerLastStage = -1;
  }
  if (typeof payload.p2UpgradeLevel === 'number' && payload.p2UpgradeLevel !== p2TowerLevel) {
    p2TowerLevel = payload.p2UpgradeLevel; p2TowerLastStage = -1;
  }
  if (typeof payload.timeLeft === 'number') multiplayerTimeLeft = payload.timeLeft;

  // Sync currency from server
  const serverCurrency = localSide === 'p1' ? payload.p1Currency : payload.p2Currency;
  if (typeof serverCurrency === 'number') currency = serverCurrency;

  // Sync siege weapon meshes
  if (payload.siegeState) syncSiegeMeshes(payload.siegeState);

  const serverIds = new Set(payload.units.map(u => u.id));

  for (const su of payload.units) {
    const existing = units.find(u => u.id === su.id);
    if (existing) {
      existing.z = su.z; existing.x = su.x;
      existing.hp = su.hp; existing.state = su.state;
      // Fix 2: sync special ability states
      if (su.stingerReady !== undefined) existing.stingerReady = su.stingerReady;
      if (su.paralyzedUntil !== undefined) existing.paralyzedUntil = su.paralyzedUntil;
    } else {
      const u = spawnUnit(su.animalId, su.side, su.id);
      u.z = su.z; u.x = su.x; u.hp = su.hp; u.maxHp = su.maxHp; u.state = su.state;
      if (su.stingerReady !== undefined) u.stingerReady = su.stingerReady;
      if (su.paralyzedUntil !== undefined) u.paralyzedUntil = su.paralyzedUntil;
    }
  }

  for (const u of units) {
    if (!serverIds.has(u.id)) u.state = 'dead';
  }
});

// Visual-only projectile fired by server siege weapon
socket.on('siegeFire', (payload: { type: 'ballista' | 'catapult'; side: Side; from: { x: number; z: number }; to: { x: number; z: number } }) => {
  if (!battleActive) return;
  const from = new THREE.Vector3(payload.from.x, 1.5, payload.from.z);
  const to = new THREE.Vector3(payload.to.x, payload.type === 'ballista' ? 1 : 0, payload.to.z);

  if (payload.type === 'ballista') {
    const dir = to.clone().sub(from).normalize();
    const tmpl = siegeWeaponTemplates.arrow;
    let mesh: THREE.Object3D | null = null;
    if (tmpl) {
      mesh = tmpl.clone(true);
      mesh.scale.setScalar(0.5);
      mesh.position.copy(from);
      mesh.lookAt(to);
      scene.add(mesh);
    }
    projectiles.push({ type: 'arrow', mesh, side: payload.side, pos: from.clone(), vel: dir.multiplyScalar(15), damage: 0, aoe: 0, done: false });
  } else {
    const horizDist = Math.sqrt((to.x - from.x) ** 2 + (to.z - from.z) ** 2);
    const tFlight = horizDist / BOULDER_H_SPEED;
    const vy0 = 0.5 * BOULDER_GRAVITY * tFlight;
    const horizDir = new THREE.Vector3(to.x - from.x, 0, to.z - from.z).normalize();
    const vel = horizDir.multiplyScalar(BOULDER_H_SPEED);
    vel.y = vy0;
    const tmpl = siegeWeaponTemplates.boulder;
    let mesh: THREE.Object3D | null = null;
    if (tmpl) {
      mesh = tmpl.clone(true);
      mesh.scale.setScalar(0.5);
      mesh.position.copy(from);
      scene.add(mesh);
    }
    projectiles.push({ type: 'boulder', mesh, side: payload.side, pos: from.clone(), vel, damage: 0, aoe: 0, done: false });
  }
});

// Server determined game result
socket.on('gameEnd', (payload: { result: 'p1win' | 'p2win' | 'draw' }) => {
  if (!battleActive) return;
  if (payload.result === 'draw') { endBattle('draw'); return; }
  const iWin = (payload.result === 'p1win' && localSide === 'p1') || (payload.result === 'p2win' && localSide === 'p2');
  endBattle(iWin ? 'win' : 'lose');
});

// ─── Chest Shop ───────────────────────────────────────────────────────────────
const CHEST_POOLS: Record<string, string[]> = {
  D: ['bee','chick','crab','penguin', 'orange','tomato','egg'],
  C: ['bee','chick','crab','penguin','bunny','eagle','fox','koala','mole',
      'orange','tomato','egg','banana','carrot','mushroom','pepper_green','pepper_red','turnip'],
  B: ['bunny','eagle','fox','koala','mole','cat','cow','deer','dog','monkey','panda','pig','giraffe','hog',
      'banana','carrot','mushroom','pepper_green','pepper_red','turnip',
      'avocado','coconut','pumpkin','broccoli','eggplant','lettuce'],
  A: ['cat','deer','dog','monkey','pig','giraffe','hog','lion','polar','tiger','elephant',
      'avocado','coconut','pumpkin','broccoli','eggplant','lettuce',
      'apple','apple_green'],
};

function rollAnimal(grade: string): string {
  const pool = CHEST_POOLS[grade] ?? CHEST_POOLS['D'];
  return pool[Math.floor(Math.random() * pool.length)];
}

function showResultCard(itemId: string, grade: string, isNew: boolean, price: number = 1) {
  const isFood = isFoodId(itemId);
  const def = isFood ? FOODS[itemId] : ANIMALS[itemId];
  if (!def) return;
  const hex = `#${def.color.toString(16).padStart(6,'0')}`;
  const gradeColor: Record<string,string> = { D:'#bbb', C:'#4af', B:'#b6f', A:'#fd0' };
  const gc = gradeColor[grade] ?? '#fff';
  const card = $('chest-result-card') as HTMLElement;
  let stats = '';
  if (isFood) {
    const f = FOODS[itemId];
    stats = `<div style="font-size:12px;color:#fff5dc;line-height:1.5;max-width:240px;">${f.desc}</div>
             <div style="margin-top:8px;font-size:13px;color:#ffd060;">비용 ${f.cost}</div>`;
  } else {
    const a = ANIMALS[itemId];
    stats = `<div style="display:flex;justify-content:center;gap:14px;font-size:13px;color:#a0ffb8;">
        <span>HP ${a.hp}</span>
        <span>ATK ${a.atk}</span>
        <span>SPD ${a.spd}</span>
      </div>`;
  }
  const tag = isFood ? `<div style="font-size:10px;color:#ffd060;letter-spacing:2px;margin-bottom:4px;">FOOD</div>` : '';
  const newBadge = isNew
    ? `<div style="font-size:11px;font-weight:900;color:#00ff88;letter-spacing:2px;margin-bottom:8px;text-shadow:0 0 8px #00ff8899;">NEW!</div>`
    : `<div style="font-size:11px;font-weight:700;color:#ffaa44;letter-spacing:1px;margin-bottom:8px;">중복 획득 (+${Math.floor(price / 2)}G 환급)</div>`;
  card.innerHTML = `
    <div style="background:rgba(8,20,5,0.95);border:2px solid ${gc};border-radius:18px;padding:20px 28px;min-width:220px;text-align:center;box-shadow:0 0 30px ${gc}44;">
      <div style="font-size:12px;font-weight:700;color:${gc};letter-spacing:2px;margin-bottom:6px;">${grade}등급</div>
      ${newBadge}
      ${tag}
      <div style="width:56px;height:56px;border-radius:50%;background:${hex};margin:0 auto 12px;box-shadow:0 0 18px ${hex}99;"></div>
      <div style="font-size:24px;font-weight:900;color:#fff;margin-bottom:12px;">${def.name}</div>
      ${stats}
    </div>`;
  card.style.display = 'block';
}

const CHEST_GRADES = [
  { grade: 'D', label: 'D등급', price: 3,  borderColor: 'rgba(160,160,160,0.5)', labelColor: '#bbb' },
  { grade: 'C', label: 'C등급', price: 8,  borderColor: 'rgba(40,160,255,0.5)',  labelColor: '#4af' },
  { grade: 'B', label: 'B등급', price: 15, borderColor: 'rgba(160,80,255,0.5)', labelColor: '#b6f' },
  { grade: 'A', label: 'A등급', price: 30, borderColor: 'rgba(255,220,0,0.5)',  labelColor: '#fd0' },
];

function buildShopChests() {
  const B = import.meta.env.BASE_URL;
  const grid = $('shop-chest-grid');
  grid.innerHTML = '';
  ($('shop-gold') as HTMLElement).textContent = `${playerGold} G`;
  const totalItems = ANIMAL_IDS.length + FOOD_IDS.length;
  const shopOwned = $('shop-owned') as HTMLElement | null;
  if (shopOwned) shopOwned.textContent = `보유 ${playerOwnedAnimals.length} / ${totalItems}`;
  for (const { grade, label, price, borderColor, labelColor } of CHEST_GRADES) {
    const card = document.createElement('div');
    card.className = 'chest-card';
    card.style.borderColor = borderColor;
    card.style.position = 'relative';
    const canBuy = playerGold >= price;
    card.innerHTML = `
      <div style="font-size:16px;font-weight:900;color:${labelColor};">${label}</div>
      <button class="chest-info-btn" data-grade="${grade}" style="position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:50%;border:1px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.1);color:#ccc;font-size:12px;font-weight:700;cursor:pointer;">?</button>
      <img src="${B}ui/chest/chest_closed_${grade}.png" alt="${label}" style="width:100%;max-width:190px;height:auto;">
      <div style="font-size:14px;color:#ffd060;font-weight:700;">${price} G</div>
      <button class="btn primary full-btn" data-grade="${grade}" data-price="${price}" style="font-size:14px;padding:10px;${canBuy ? '' : 'opacity:0.4;pointer-events:none;'}">열기</button>
    `;
    grid.appendChild(card);
  }
  grid.querySelectorAll('button[data-grade][data-price]').forEach(btn => {
    btn.addEventListener('click', () => {
      const grade = (btn as HTMLElement).dataset.grade!;
      const price = parseInt((btn as HTMLElement).dataset.price!);
      triggerChestOpen(grade, price);
    });
  });
  grid.querySelectorAll('.chest-info-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const grade = (btn as HTMLElement).dataset.grade!;
      const gradeLabel: Record<string,string> = { D:'D등급', C:'C등급', B:'B등급', A:'A등급' };
      const gradeColor: Record<string,string> = { D:'#bbb', C:'#4af', B:'#b6f', A:'#fd0' };
      $('chest-info-title').innerHTML = `<span style="color:${gradeColor[grade]}">${gradeLabel[grade]}</span> 획득 가능 목록`;
      const pool = CHEST_POOLS[grade] ?? [];
      const listEl = $('chest-info-list');
      listEl.innerHTML = pool.map(id => {
        const isFood = isFoodId(id);
        const def = isFood ? FOODS[id] : ANIMALS[id];
        const hex = def ? `#${def.color.toString(16).padStart(6,'0')}` : '#888';
        return `<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:8px;background:rgba(255,255,255,0.06);font-size:12px;">
          <span style="width:10px;height:10px;border-radius:50%;background:${hex};display:inline-block;flex-shrink:0;"></span>
          <span>${def?.name ?? id}</span>
          ${isFood ? '<span style="font-size:9px;color:#ffd060;margin-left:2px;">FOOD</span>' : ''}
        </div>`;
      }).join('');
      ($('chest-info-overlay') as HTMLElement).style.display = 'flex';
    });
  });
  $('btn-chest-info-close').addEventListener('click', () => { ($('chest-info-overlay') as HTMLElement).style.display = 'none'; });
}

function triggerChestOpen(grade: string, price: number) {
  if (playerGold < price) return;
  const B = import.meta.env.BASE_URL;
  const overlay = $('chest-overlay');
  const img = $('chest-anim-img') as HTMLImageElement;
  const resultCard = $('chest-result-card') as HTMLElement;
  const closeBtn = $('btn-chest-close') as HTMLButtonElement;

  playerGold -= price;
  const rolledAnimal = rollAnimal(grade);

  // Unlock animal / give duplicate refund
  const isNew = !playerOwnedAnimals.includes(rolledAnimal);
  if (isNew) {
    playerOwnedAnimals.push(rolledAnimal);
  } else {
    playerGold += Math.floor(price / 2); // duplicate refund = half price
  }

  img.src = `${B}ui/chest/chest_closed_${grade}.png`;
  img.style.opacity = '1';
  resultCard.style.display = 'none';
  resultCard.innerHTML = '';
  closeBtn.style.opacity = '0';
  closeBtn.style.pointerEvents = 'none';
  overlay.style.display = 'flex';

  // 1. 흔들기
  img.classList.add('chest-shaking');
  setTimeout(() => {
    img.classList.remove('chest-shaking');
    img.style.opacity = '0';
    // 2. 빛나는 열린 상자
    setTimeout(() => {
      img.src = `${B}ui/chest/chest_open_glow_${grade}.png`;
      img.style.opacity = '1';
      setTimeout(() => {
        img.style.opacity = '0';
        // 3. 열린 상자 + 결과 카드
        setTimeout(() => {
          img.src = `${B}ui/chest/chest_open_${grade}.png`;
          img.style.opacity = '1';
          showResultCard(rolledAnimal, grade, isNew, price);
          closeBtn.style.opacity = '1';
          closeBtn.style.pointerEvents = 'auto';
        }, 200);
      }, 700);
    }, 200);
  }, 600);
}

$('btn-chest-close').addEventListener('click', () => {
  $('chest-overlay').style.display = 'none';
  buildShopChests();
  updateHomeDisplay();
});

$('btn-test-gold')?.addEventListener('click', () => {
  playerGold += 100;
  buildShopChests();
});

// ─── Button Handlers ──────────────────────────────────────────────────────────

// Initial
$('btn-start').addEventListener('click', () => {
  const nick = ($('in-nickname') as HTMLInputElement).value.trim().slice(0, 12);
  if (!nick) { $('nickname-error').textContent = '닉네임을 입력해주세요'; return; }
  $('nickname-error').textContent = '';
  localStorage.setItem('zoo_nickname', nick);
  loggedInUsername = loggedInUsername || nick; // keep logged-in username if exists
  guestNickname = nick;
  playerGold = 0;
  playerOwnedAnimals = [...DEFAULT_DECK];
  updateHomeDisplay();
  showScreen('home');
});
$('btn-load-progress').addEventListener('click', () => showScreen('login'));
$('btn-lb-back').addEventListener('click', () => {
  if (lbRefreshInterval) { clearInterval(lbRefreshInterval); lbRefreshInterval = null; }
  showScreen('home');
});
$('btn-lb-refresh').addEventListener('click', () => loadLeaderboard(lbTab));
$('lb-tab-words').addEventListener('click', () => loadLeaderboard('words'));
$('lb-tab-clear').addEventListener('click', () => loadLeaderboard('clear'));
$('btn-lb-delete').addEventListener('click', async () => {
  const nick = loggedInUsername || guestNickname;
  if (!nick) return;
  if (!confirm(`"${nick}" 의 기록을 삭제할까요?`)) return;
  const btn = $('btn-lb-delete') as HTMLButtonElement;
  btn.textContent = '삭제 중...';
  btn.disabled = true;
  const ok = await deleteMyLeaderboard(nick);
  if (ok) { btn.style.display = 'none'; loadLeaderboard(lbTab); }
  else { btn.textContent = '삭제 실패 (본인 기록만 삭제 가능)'; btn.disabled = false; }
});

// Home
$('btn-home-leaderboard').addEventListener('click', () => {
  showScreen('leaderboard');
  loadLeaderboard('words');
  if (lbRefreshInterval) clearInterval(lbRefreshInterval);
  lbRefreshInterval = setInterval(() => { if (currentScreen === 'leaderboard') loadLeaderboard(lbTab); }, 60000);
});
$('btn-home-1p').addEventListener('click', () => {
  gameMode = '1p';
  localSide = 'p1';
  startBattle();
});
$('btn-home-2p').addEventListener('click', () => {
  gameMode = '2p';
  showScreen('lobby2p');
});
$('btn-home-deck').addEventListener('click', () => {
  console.log('[deck] btn-home-deck clicked');
  try {
    buildDeckCards();
    console.log('[deck] buildDeckCards OK, deck=', playerDeck);
  } catch(e) {
    console.error('[deck] buildDeckCards threw:', e);
  }
  try {
    showScreen('deck');
    console.log('[deck] showScreen(deck) OK');
  } catch(e) {
    console.error('[deck] showScreen threw:', e);
  }
});
$('btn-home-save').addEventListener('click', async () => {
  if (!loggedInUserId) {
    // 게스트 → 아이디 생성 화면으로 이동해서 가입 후 저장
    signupFrom = 'home';
    $('signup-error').textContent = '';
    ($('signup-hint') as HTMLElement).style.display = 'block';
    showScreen('signup');
    return;
  }
  const btn = $('btn-home-save') as HTMLButtonElement;
  btn.textContent = '저장 중...';
  btn.disabled = true;
  const result = await saveProfile(loggedInUserId, { gold: playerGold, deck: playerDeck, owned_animals: [...playerOwnedAnimals] });
  if (result.ok) {
    btn.textContent = '저장 완료';
    btn.style.color = '#a0ffb8';
  } else {
    btn.textContent = '저장 실패';
    btn.style.color = '#ff8888';
    // 오류 메시지 잠깐 표시
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'font-size:11px;color:#ff8888;margin-top:4px;text-align:center;max-width:240px;';
    errDiv.textContent = result.message ?? '알 수 없는 오류';
    btn.insertAdjacentElement('afterend', errDiv);
    setTimeout(() => errDiv.remove(), 5000);
  }
  btn.disabled = false;
  setTimeout(() => { btn.textContent = '진행상황 저장하기'; btn.style.color = ''; }, 2000);
});

// Deck
$('btn-deck-back').addEventListener('click', () => showScreen('home'));
$('btn-shop-back').addEventListener('click', () => showScreen('home'));
$('btn-home-shop').addEventListener('click', () => { buildShopChests(); showScreen('shop'); });

// Lobby
$('btn-lobby-back').addEventListener('click', () => {
  socket.disconnect();
  showScreen('home');
});
$('btn-rndroom').addEventListener('click', () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += a[Math.floor(Math.random() * a.length)];
  ($('in-room') as HTMLInputElement).value = c;
});
$('btn-joinroom').addEventListener('click', () => {
  const nick = (loggedInUsername || 'Guest').slice(0, 16);
  const room = ($('in-room') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!room) { $('lobby-status').textContent = '방 코드를 입력하세요'; return; }
  $('lobby-status').textContent = '서버 연결 중...';
  const payload = { nickname: nick, roomCode: room };
  if (socket.connected) {
    socket.emit('battleJoin', payload);
  } else {
    // store payload — emitted in connect handler above
    (socket as any).__pendingJoin = payload;
    socket.connect();
  }
});

// Result
$('btn-result-menu').addEventListener('click', () => {
  clearBattle();
  if (socket.connected) socket.disconnect();
  updateHomeDisplay();
  showScreen('home');
});

// ─── Main Loop ────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  updateCamera(dt);

  if (battleActive) {
    battleClock += dt;
    autoCurrencyTimer += dt;
    if (autoCurrencyTimer >= CURRENCY_AUTO_INTERVAL) {
      autoCurrencyTimer -= CURRENCY_AUTO_INTERVAL;
      if (gameMode === '1p') addCurrency(1); // 2P: server handles auto-currency
    }

    // Quiz event timer
    quizEventTriggerTimer -= dt;
    if (quizEventTriggerTimer <= 0) {
      quizEventTriggerTimer = 60;
      startQuizEvent();
    }

    if (gameMode === '1p' && !quizEventActive) stepUnits(dt);
    syncUnitMeshes();
    for (const u of units) u.mixer?.update(dt);
    if (gameMode === '1p' && !quizEventActive) stepSiegeWeapons(dt);
    stepProjectiles(dt); // always run — damage=0 for 2P visual-only projectiles
    if (gameMode === '1p') {
      stepFoodProjectiles(dt);
      stepFoodZones(dt);
      stepFoodBuffs(dt);
      stepCoconutShockwaves(dt);
    }
    stepParticles(dt);

    if (p1Base.hp !== p1Base.lastHp || p2Base.hp !== p2Base.lastHp) {
      syncBaseMeshes();
      updateHud();
    }

    if (gameMode === '1p') {
      checkWinLose();
      step1PAI(dt);
    }

    updateBossSpawnEffects(dt);

    if (spamLockUntil > 0 && battleClock >= spamLockUntil) {
      spamLockUntil = 0;
      $('choices').style.visibility = 'visible';
      ($('type-input') as HTMLInputElement).disabled = false;
      showQuizMsg('');
    }

    if (quizMsgTimer > 0) {
      quizMsgTimer -= dt;
      if (quizMsgTimer <= 0) $('quiz-msg').textContent = '';
    }

    updateHud();
  }

  if (!battleActive && activeParticles.length > 0) activeParticles.length = 0;

  if (quizEventActive) {
    quizEventPhaseTimer -= dt;
    const phaseDur = 5;
    $('qe-timer-fill').style.width = Math.max(0, quizEventPhaseTimer / phaseDur * 100) + '%';
    if (quizEventPhaseTimer <= 0 && !quizEventAnswered) {
      if (quizEventPhase === 'study') {
        advanceQuizEventToQuiz();
      } else {
        // Time ran out on quiz
        endQuizEvent();
      }
    }
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function applyProfile(username: string, userId: string, profile: UserProfile) {
  loggedInUsername = username;
  loggedInUserId = userId;
  playerGold = profile.gold;
  playerDeck = profile.deck.length ? profile.deck : [...DEFAULT_DECK];
  playerOwnedAnimals = profile.owned_animals.length ? profile.owned_animals : [...DEFAULT_DECK];
  // Sanitize deck: remove any item no longer owned
  playerDeck = playerDeck.filter(id => playerOwnedAnimals.includes(id));
  if (playerDeck.length === 0) playerDeck = [...DEFAULT_DECK].filter(id => playerOwnedAnimals.includes(id));
  updateHomeDisplay();
  showScreen('home');
}

async function handleLogin() {
  const id = ($('in-login-id') as HTMLInputElement).value.trim();
  const pw = ($('in-login-pw') as HTMLInputElement).value;
  const errEl = $('login-error');
  if (!id || !pw) { errEl.textContent = '아이디와 비밀번호를 입력하세요'; return; }
  errEl.textContent = '';
  ($('btn-login') as HTMLButtonElement).disabled = true;
  const { data, error } = await supabase.auth.signInWithPassword({ email: toEmail(id), password: pw });
  ($('btn-login') as HTMLButtonElement).disabled = false;
  if (error || !data.user) { errEl.textContent = '아이디 또는 비밀번호가 틀렸습니다'; return; }
  showScreen('loading');
  const profile = await ensureProfile(data.user.id);
  await applyProfile(id, data.user.id, profile);
}

async function handleSignupConfirm() {
  const id  = ($('in-signup-id') as HTMLInputElement).value.trim();
  const pw1 = ($('in-signup-pw1') as HTMLInputElement).value;
  const pw2 = ($('in-signup-pw2') as HTMLInputElement).value;
  const errEl = $('signup-error');
  if (!id || !pw1 || !pw2) { errEl.textContent = '모든 항목을 입력하세요'; return; }
  if (pw1.length < 6) { errEl.textContent = '비밀번호는 6자 이상이어야 합니다'; return; }
  if (pw1 !== pw2) { errEl.textContent = '비밀번호가 일치하지 않습니다'; return; }
  errEl.textContent = '';
  ($('btn-signup-confirm') as HTMLButtonElement).disabled = true;
  const { data, error } = await supabase.auth.signUp({ email: toEmail(id), password: pw1 });
  ($('btn-signup-confirm') as HTMLButtonElement).disabled = false;
  if (error) {
    errEl.textContent = error.message.includes('already') ? '이미 사용 중인 아이디입니다' : error.message;
    return;
  }
  if (!data.user) { errEl.textContent = '생성 실패. 다시 시도하세요'; return; }
  showScreen('loading');
  if (signupFrom === 'home') {
    // 게스트 진행 상황(덱·골드)을 새 계정에 저장
    const profile = { gold: playerGold, deck: [...playerDeck], owned_animals: [...playerOwnedAnimals] };
    await supabase.from('profiles').upsert({ id: data.user.id, ...profile });
    await applyProfile(id, data.user.id, profile);
  } else {
    const profile = await ensureProfile(data.user.id);
    await applyProfile(id, data.user.id, profile);
  }
  ($('signup-hint') as HTMLElement).style.display = 'none';
  signupFrom = 'initial';
}

$('btn-login').addEventListener('click', handleLogin);
($('in-login-pw') as HTMLInputElement).addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
$('btn-go-signup').addEventListener('click', () => {
  $('signup-error').textContent = '';
  showScreen('signup');
});
$('btn-login-back').addEventListener('click', () => showScreen('initial'));

$('btn-signup-confirm').addEventListener('click', handleSignupConfirm);
($('in-signup-pw2') as HTMLInputElement).addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSignupConfirm(); });
$('btn-signup-back').addEventListener('click', () => {
  ($('signup-hint') as HTMLElement).style.display = 'none';
  const from = signupFrom;
  signupFrom = 'initial';
  showScreen(from === 'home' ? 'home' : 'login');
});

// Restore session on page load
supabase.auth.getSession().then(async ({ data }) => {
  const user = data.session?.user;
  if (user?.email) {
    const username = user.email.replace('@zoobattle.local', '');
    showScreen('loading');
    const profile = await ensureProfile(user.id);
    await applyProfile(username, user.id, profile);
  }
});

animate();
