import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { io } from 'socket.io-client';
import { wordList } from './words';
import { ANIMALS, ANIMAL_IDS, BASE_HP, BASE_HP_1P_ENEMY, FIELD_LEN, SPAWN_P1, SPAWN_P2, AIR_Y, MOLE_SURFACE_DETECT } from './animals';
import type { AnimalDef } from './animals';
import { supabase, toEmail, saveProfile, ensureProfile, DEFAULT_DECK } from './supabase';
import type { UserProfile } from './supabase';

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
    modelScale: 0.0707, collisionSize: 3.0,
    aoe: 3,
    animWalk: 'Dragon_Flying', animAtk: 'Dragon_Attack',
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
    ...(def.aoe ? { aoe: def.aoe } as unknown as Partial<AnimalDef> : {}),
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
const tdBase = `${import.meta.env.BASE_URL}kenney_tower-defense-kit/Models/GLB%20format/`;
const nkBase = `${import.meta.env.BASE_URL}kenney_nature-kit/Models/GLTF%20format/`;

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
const treeTemplates: THREE.Group[] = [];
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
  for (const name of ['tree_default', 'tree_cone', 'tree_oak']) {
    loader.load(`${nkBase}${name}.glb`, g => { treeTemplates.push(g.scene); placeBackgroundTrees(); }, undefined, () => {});
  }
}
loadEnvironment();

function placeBackgroundTrees() {
  // Called each time a new tree template loads — deduplicate by checking if already placed
  if (treeTemplates.length === 0) return;
  // Only place when we have at least 2 templates for variety, or on first load
  if (treeTemplates.length > 1 && scene.children.filter(c => (c as any).__isBgTree).length > 0) return;

  // Remove old trees if re-placing
  const old = scene.children.filter(c => (c as any).__isBgTree);
  old.forEach(o => scene.remove(o));

  const rng = (min: number, max: number) => min + Math.random() * (max - min);
  for (let z = -2; z <= FIELD_LEN + 2; z += 3.5) {
    for (const side of [-1, 1]) {
      const tmpl = treeTemplates[Math.floor(Math.random() * treeTemplates.length)];
      const tree = tmpl.clone(true);
      const s = rng(1.6, 2.8);
      tree.scale.set(s, s, s);
      tree.position.set(side * rng(14, 20), 0, z + rng(-1.5, 1.5));
      tree.rotation.y = rng(0, Math.PI * 2);
      (tree as any).__isBgTree = true;
      scene.add(tree);
    }
  }
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
const HP_PER_UPGRADE = 30;   // 2 upgrades × 30 = +60 → max = 2× BASE_HP
const UPGRADE_COSTS = [10, 15];

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
const ROUND_DURATION = 30; // seconds per round

// 1P AI spawn tables per round [animalId, weight]
const AI_ROUNDS: Array<{ interval: number; pool: string[] }> = [
  { interval: 5.0, pool: ['penguin','chick','crab','mole'] },
  { interval: 4.0, pool: ['penguin','dog','cat','mole','lion'] },
  { interval: 3.5, pool: ['dog','lion','eagle','monkey','deer'] },
  { interval: 3.0, pool: ['lion','elephant','eagle','monkey','polar'] },
  { interval: 2.5, pool: ['lion','elephant','eagle','monkey','tiger','polar','mole'] },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type GameMode = '1p' | '2p';
type Screen = 'initial' | 'login' | 'signup' | 'loading' | 'home' | 'deck' | 'shop' | 'lobby2p' | 'battle' | 'result';
let loggedInUsername = '';
let loggedInUserId = '';
let playerGold = 0;
let signupFrom: 'initial' | 'home' = 'initial'; // where signup was triggered from
const GOLD_PER_WIN = 10;
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

  const model = template.clone(true);
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

function spawnUnit(animalId: string, side: Side, forcedId?: string): UnitSim {
  const def = ANIMALS[animalId];
  const id = forcedId ?? `u${++unitIdCounter}`;
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
  }
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
      if (u.atkTimer <= 0) { dealDamage(u, closest, def.atk, now); u.atkTimer = def.atkCooldown; }
      return;
    }
    if (baseDist <= def.range) {
      u.state = 'attacking';
      if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - def.atk); u.atkTimer = def.atkCooldown; }
      return;
    }
    u.state = 'moving'; u.z += dir * def.spd * dt; return;
  }

  if (closest && closestDist <= def.range) {
    u.state = 'attacking';
    if (u.atkTimer <= 0) { dealDamage(u, closest, def.atk, now); u.atkTimer = def.atkCooldown; }
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

function stepMole(u: UnitSim, dt: number, dir: number, enemies: UnitSim[], base: BaseSim, now: number) {
  const def = ANIMALS['mole'];
  const groundEnemies = enemies.filter(e => ANIMALS[e.animalId].layer !== 'air');
  const baseDist = Math.abs(base.z - u.z);

  if (u.state === 'underground') {
    const nearEnemy = groundEnemies.find(e => Math.abs(e.z - u.z) <= MOLE_SURFACE_DETECT);
    if (nearEnemy || baseDist <= def.range) { u.state = 'moving'; }
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
    if (u.atkTimer <= 0) { base.hp = Math.max(0, base.hp - def.atk); u.atkTimer = def.atkCooldown; }
    return;
  }
  if (nearest) { u.state = 'moving'; u.z += dir * def.spd * dt; return; }
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
let roundTimer = 0;
let aiSpawnTimer = 0;

let multiplayerTimeLeft = 120;

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
  body{font-family:system-ui,sans-serif;color:#e8eefc;touch-action:manipulation;}
  .screen{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(8,14,30,0.96);z-index:50;}
  .screen.hidden{display:none;}
  .btn{padding:12px 28px;border-radius:12px;border:1px solid rgba(255,255,255,0.25);background:#2a4080;color:#e8eefc;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.15s;}
  .btn:hover{background:#3a55aa;}
  .btn.primary{background:#41c1ff;color:#031523;}
  .btn.primary:hover{background:#60d0ff;}
  .btn.green{background:#2a7a4a;border-color:rgba(80,220,120,0.5);color:#a0ffb8;}
  .btn.green:hover{background:#3a9a5a;}
  .btn.danger{background:#c03030;}
  .btn:disabled{opacity:0.4;cursor:not-allowed;}
  h1{font-size:2.4em;margin:0 0 32px;letter-spacing:2px;}
  h2{font-size:1.6em;margin:0 0 20px;}
  input.field{padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.07);color:#e8eefc;font-size:15px;outline:none;width:240px;}
  .gap{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;}
  .animal-card{padding:12px 16px;border-radius:12px;border:2px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);min-width:110px;text-align:center;font-size:13px;cursor:default;}
  .animal-card .aname{font-size:15px;font-weight:700;margin-bottom:6px;}
  .animal-card .astat{opacity:0.75;line-height:1.6;}
  .full-btn{width:100%;padding:14px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,0.25);transition:background 0.15s;}
</style>

<!-- INITIAL -->
<div id="screen-initial" class="screen">
  <h1>Zoo Battle</h1>
  <div style="display:flex;flex-direction:column;align-items:center;gap:12px;width:220px;">
    <button class="btn primary full-btn" id="btn-start" style="font-size:18px;">시작하기</button>
    <button class="btn full-btn" id="btn-load-progress" style="background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.18);font-size:14px;padding:10px;">로그인 (진행상황 불러오기)</button>
  </div>
</div>

<!-- LOGIN -->
<div id="screen-login" class="screen hidden">
  <h2 style="margin-bottom:20px;">로그인</h2>
  <div style="width:100%;max-width:300px;display:flex;flex-direction:column;gap:10px;">
    <input class="field" id="in-login-id" placeholder="아이디" autocomplete="username">
    <input class="field" id="in-login-pw" type="password" placeholder="비밀번호" autocomplete="current-password">
    <div id="login-error" style="color:#ff7070;font-size:13px;min-height:18px;text-align:center;"></div>
    <button class="btn primary full-btn" id="btn-login">로그인</button>
    <button class="btn green full-btn" id="btn-go-signup" style="font-size:15px;">아이디 생성</button>
    <button class="btn full-btn" id="btn-login-back" style="background:transparent;border-color:rgba(255,255,255,0.15);font-size:13px;padding:10px;opacity:0.6;">← 돌아가기</button>
  </div>
</div>

<!-- SIGNUP -->
<div id="screen-signup" class="screen hidden">
  <h2 style="margin-bottom:20px;">아이디 생성</h2>
  <div style="width:100%;max-width:300px;display:flex;flex-direction:column;gap:10px;">
    <div id="signup-hint" style="display:none;background:rgba(65,193,255,0.12);border:1px solid rgba(65,193,255,0.35);border-radius:10px;padding:10px 12px;font-size:13px;color:#a8e6ff;text-align:center;line-height:1.5;">아이디를 만들면 현재 덱과 골드가<br>자동으로 저장됩니다 💾</div>
    <input class="field" id="in-signup-id" placeholder="아이디" autocomplete="username">
    <input class="field" id="in-signup-pw1" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="new-password">
    <input class="field" id="in-signup-pw2" type="password" placeholder="비밀번호 확인" autocomplete="new-password">
    <div id="signup-error" style="color:#ff7070;font-size:13px;min-height:18px;text-align:center;"></div>
    <button class="btn primary full-btn" id="btn-signup-confirm">아이디 생성</button>
    <button class="btn full-btn" id="btn-signup-back" style="background:transparent;border-color:rgba(255,255,255,0.15);font-size:13px;padding:10px;opacity:0.6;">← 돌아가기</button>
  </div>
</div>

<!-- LOADING -->
<div id="screen-loading" class="screen hidden">
  <div style="width:48px;height:48px;border:5px solid rgba(255,255,255,0.15);border-top-color:#41c1ff;border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:20px;"></div>
  <div style="color:#a0c8ff;font-size:16px;">불러오는 중...</div>
</div>

<!-- HOME -->
<div id="screen-home" class="screen hidden">
  <div style="position:absolute;top:0;left:0;right:0;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.35);border-bottom:1px solid rgba(255,255,255,0.08);">
    <span id="home-username" style="font-size:14px;color:#adf;font-weight:700;">Guest</span>
    <span id="home-gold" style="font-size:14px;color:#ffd060;font-weight:700;">💰 0</span>
  </div>
  <h1 style="margin-bottom:24px;">Zoo Battle</h1>
  <div style="display:flex;flex-direction:column;align-items:center;gap:10px;width:220px;">
    <button class="btn primary full-btn" id="btn-home-1p" style="font-size:17px;">혼자서 플레이</button>
    <button class="btn primary full-btn" id="btn-home-2p" style="font-size:17px;">둘이서 플레이</button>
    <button class="btn full-btn" id="btn-home-deck">덱</button>
    <button class="btn full-btn" id="btn-home-shop" disabled style="opacity:0.4;font-size:14px;">상점 (준비 중)</button>
    <button class="btn full-btn" id="btn-home-save" style="background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.18);font-size:13px;padding:10px;opacity:0.7;">진행상황 저장하기</button>
  </div>
</div>

<!-- DECK -->
<div id="screen-deck" class="screen hidden" style="padding:16px;justify-content:flex-start;padding-top:28px;">
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:14px;width:100%;max-width:640px;">
    <h2 style="margin:0;flex:1;">덱 구성</h2>
    <span id="deck-count" style="font-size:14px;color:#adf;white-space:nowrap;">0 / 6 선택</span>
  </div>
  <div id="deck-cards" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;overflow-y:auto;width:100%;max-width:640px;flex:1;align-content:start;padding-bottom:8px;"></div>
  <div style="margin-top:14px;width:100%;max-width:640px;" class="gap">
    <button class="btn" id="btn-deck-back">← 저장하고 돌아가기</button>
  </div>
</div>

<!-- SHOP (placeholder) -->
<div id="screen-shop" class="screen hidden">
  <h2>상점</h2>
  <p style="opacity:0.5;">준비 중입니다.</p>
  <button class="btn" id="btn-shop-back">← 돌아가기</button>
</div>

<!-- 2P LOBBY -->
<div id="screen-lobby2p" class="screen hidden">
  <h2>2인 대전 로비</h2>
  <input class="field" id="in-room" placeholder="방 코드 (예: BATTLE1)" style="margin-bottom:10px;">
  <div class="gap" style="margin-bottom:10px;">
    <button class="btn" id="btn-rndroom">랜덤 코드</button>
    <button class="btn primary" id="btn-joinroom">참가</button>
  </div>
  <div id="lobby-status" style="font-size:13px;opacity:0.8;min-height:20px;"></div>
  <button class="btn" id="btn-lobby-back" style="margin-top:16px;">← 돌아가기</button>
</div>

<!-- RESULT -->
<div id="screen-result" class="screen hidden">
  <h2 id="result-text">결과</h2>
  <div id="result-gold" style="font-size:15px;color:#ffd060;font-weight:700;margin-bottom:12px;min-height:22px;"></div>
  <button class="btn primary" id="btn-result-menu">홈으로</button>
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
    <div id="summon-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;overflow-y:auto;flex:1;align-content:start;padding-right:2px;"></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
      <button id="btn-upgrade" style="flex:1;min-width:120px;padding:5px 6px;border-radius:8px;border:1px solid rgba(255,200,80,0.5);background:rgba(255,200,80,0.12);color:#ffe08a;font-weight:700;cursor:pointer;font-size:10px;">⬆ 기지 업그레이드</button>
      <span id="upgrade-info" style="font-size:10px;opacity:0.7;white-space:nowrap;min-width:40px;text-align:right;"></span>
      <button id="btn-ballista" style="padding:5px 6px;border-radius:8px;border:1px solid rgba(100,200,255,0.4);background:rgba(100,200,255,0.1);color:#aae4ff;font-weight:700;cursor:pointer;font-size:10px;white-space:nowrap;">발리스타 (10)</button>
      <button id="btn-catapult" style="padding:5px 6px;border-radius:8px;border:1px solid rgba(255,160,80,0.4);background:rgba(255,160,80,0.1);color:#ffc888;font-weight:700;cursor:pointer;font-size:10px;white-space:nowrap;">박격포 (10)</button>
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
function showScreen(s: Screen) {
  currentScreen = s;
  const screens = ['initial','login','signup','loading','home','deck','shop','lobby2p','result'];
  for (const id of screens) $(`screen-${id}`).classList.toggle('hidden', s !== id);
  $('panel-battle').style.display = s === 'battle' ? 'block' : 'none';
  $('top-hud').style.display = s === 'battle' ? 'block' : 'none';
  renderer.domElement.style.display = s === 'battle' ? 'block' : 'none';
}

function updateHomeDisplay() {
  ($('home-username') as HTMLElement).textContent = loggedInUsername || 'Guest';
  ($('home-gold') as HTMLElement).textContent = `💰 ${playerGold}`;
}

showScreen('initial');
renderer.domElement.style.display = 'none';

// ─── Deck Screen ──────────────────────────────────────────────────────────────
const DECK_MAX = 6;
let playerDeck: string[] = [...DEFAULT_DECK];

function buildDeckCards() {
  const container = $('deck-cards');
  container.innerHTML = '';
  for (const id of ANIMAL_IDS) {
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
      <div style="opacity:0.75;line-height:1.6;font-size:11px;">
        HP ${d.hp} / ATK ${d.atk}<br>
        SPD ${d.spd} / 비용 <b>${d.cost}</b>
      </div>`;
    card.addEventListener('click', () => toggleDeckCard(id));
    container.appendChild(card);
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
  for (const id of deck) {
    const d = ANIMALS[id];
    const btn = document.createElement('button');
    btn.dataset.id = id;
    btn.style.cssText = 'border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);color:#e8eefc;font-weight:700;cursor:pointer;font-size:12px;padding:4px 2px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;';
    btn.innerHTML = `<span style="font-size:14px;color:#fff">${d.name}</span><span style="opacity:0.8;font-size:11px;">비용 ${d.cost}</span>`;
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
    btn.textContent = '⬆ 기지 최대 레벨';
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    info.textContent = 'MAX';
  } else {
    const cost = UPGRADE_COSTS[myLevel];
    btn.textContent = `⬆ 업그레이드 (${cost}재화)`;
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
  } else {
    socket.emit('battleSpawn', { animalId }); // single emit — server handles groupSpawn
  }
}

($('btn-upgrade') as HTMLButtonElement).addEventListener('click', upgradeBase);
($('btn-ballista') as HTMLButtonElement).addEventListener('click', () => buySiege('ballista'));
($('btn-catapult') as HTMLButtonElement).addEventListener('click', () => buySiege('catapult'));

$('btn-cammode').addEventListener('click', () => {
  camMode = camMode === 'side' ? 'top' : 'side';
  ($('btn-cammode') as HTMLButtonElement).textContent = camMode === 'top' ? '👁 측면' : '👁 시점';
});

// ─── Battle Init ──────────────────────────────────────────────────────────────
function clearBattle() {
  for (const u of [...units]) removeUnitMeshes(u);
  units = [];
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
  }

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
    // Bird's-eye: straight down over field center, own base at bottom of screen
    camera.fov = 80;
    camera.updateProjectionMatrix();
    camera.up.set(0, 0, localSide === 'p1' ? 1 : -1);
    const midZ = (SPAWN_P1 + SPAWN_P2) / 2;
    camera.position.set(0, 36, midZ);
    camera.lookAt(0, 0, midZ);
    return;
  }

  // Restore side-view camera settings
  if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); }
  if (camera.up.y !== 1) camera.up.set(0, 1, 0);

  // Inertia: continue sliding after release, decay with friction
  if (!camPanActive && Math.abs(camPanVel) > 0.01) {
    camPan = Math.max(-15, Math.min(15, camPan + camPanVel * dt));
    camPanVel *= Math.max(0, 1 - 9 * dt);
  } else if (!camPanActive) {
    camPanVel = 0;
  }

  const baseZ = localSide === 'p1' ? FIELD_LEN * 0.33 : FIELD_LEN * 0.67;
  const lookZ = baseZ + camPan;
  if (localSide === 'p1') {
    camera.position.set(8, 5, lookZ);
    camera.lookAt(0, 2, lookZ);
  } else {
    camera.position.set(-8, 5, lookZ);
    camera.lookAt(0, 2, lookZ);
  }
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── HUD ──────────────────────────────────────────────────────────────────────
function updateHud() {
  $('hud-currency').textContent = `재화: ${currency} / ${CURRENCY_MAX}`;
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
    if (round >= AI_ROUNDS.length) {
      endBattle('win');
    } else {
      round++;
      roundTimer = ROUND_DURATION;
      aiSpawnTimer = AI_ROUNDS[Math.min(round - 1, AI_ROUNDS.length - 1)].interval;
    }
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
  $('result-text').textContent = result === 'win' ? '🎉 승리!' : result === 'lose' ? '💀 패배...' : '🤝 무승부!';
  let goldMsg = '';
  if (result === 'win' && gameMode === '1p') {
    playerGold += GOLD_PER_WIN;
    goldMsg = `+${GOLD_PER_WIN} 💰 골드 획득!`;
  }
  ($('result-gold') as HTMLElement).textContent = goldMsg;
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
  if (e.isComposing) return; // IME 한글 조합 중 Enter 무시
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
  if (gameMode === '2p' && amt > 0 && battleActive) {
    socket.emit('currencyEarn', { amount: amt });
  }
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

// ─── Button Handlers ──────────────────────────────────────────────────────────

// Initial
$('btn-start').addEventListener('click', () => {
  loggedInUsername = '';
  loggedInUserId = '';
  playerGold = 0;
  updateHomeDisplay();
  showScreen('home');
});
$('btn-load-progress').addEventListener('click', () => showScreen('login'));

// Home
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
  const ok = await saveProfile(loggedInUserId, { gold: playerGold, deck: playerDeck, owned_animals: [...ANIMAL_IDS] });
  btn.textContent = ok ? '저장 완료 ✓' : '저장 실패';
  btn.disabled = false;
  setTimeout(() => { btn.textContent = '진행상황 저장하기'; }, 2000);
});

// Deck
$('btn-deck-back').addEventListener('click', () => showScreen('home'));
$('btn-shop-back').addEventListener('click', () => showScreen('home'));

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
  $('lobby-status').textContent = '연결 중...';
  if (!socket.connected) socket.connect();
  socket.emit('battleJoin', { nickname: nick, roomCode: room });
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
      addCurrency(1);
    }

    if (gameMode === '1p') stepUnits(dt);
    syncUnitMeshes();
    for (const u of units) u.mixer?.update(dt);
    if (gameMode === '1p') stepSiegeWeapons(dt);
    stepProjectiles(dt); // always run — damage=0 for 2P visual-only projectiles

    if (p1Base.hp !== p1Base.lastHp || p2Base.hp !== p2Base.lastHp) {
      syncBaseMeshes();
      updateHud();
    }

    if (gameMode === '1p') {
      checkWinLose();
      step1PAI(dt);
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

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function applyProfile(username: string, userId: string, profile: UserProfile) {
  loggedInUsername = username;
  loggedInUserId = userId;
  playerGold = profile.gold;
  playerDeck = profile.deck.length ? profile.deck : [...DEFAULT_DECK];
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
    const profile = { gold: playerGold, deck: [...playerDeck], owned_animals: [...ANIMAL_IDS] };
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
