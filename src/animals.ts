export type AnimalLayer = 'ground' | 'air' | 'underground';
export type AttackLayer = 'ground' | 'air' | 'both';

export interface AnimalDef {
  id: string;
  name: string;
  layer: AnimalLayer;
  attackLayer: AttackLayer;
  hp: number;
  atk: number;
  spd: number;
  atkCooldown: number;
  range: number;
  cost: number;
  size: number;
  color: number;
  ranged?: boolean;    // stops at range, never closes to melee (monkey, koala)
  evasion?: number;    // 0-1 chance to dodge incoming attacks (cat: 0.5)
  groupSpawn?: number; // spawn N units at once (chick: 4)
  stinger?: boolean;   // first attack paralyzes target (bee)
  jumping?: boolean;   // gravity-based continuous jumping (bunny)
  charge?: boolean;    // fast animation speed (hog)
  leap?: boolean;      // leaps at enemies 5+ units away (tiger)
  leapRange?: number;  // distance threshold to trigger leap
}

// Size tiers:
//  매우작음 (0.25): bee, chick
//  작음     (0.40): bunny, cat, crab, penguin, fox, parrot
//  중간     (0.55): dog, monkey, koala, beaver, pig, panda
//  큼       (0.70): lion, deer, cow, hog, polar bear
//  매우큼   (0.95): elephant, giraffe, tiger

// atkCooldown = 3 / attackSpeed
export const ANIMALS: Record<string, AnimalDef> = {
  lion: {
    id: 'lion', name: '사자',
    layer: 'ground', attackLayer: 'ground',
    hp: 20, atk: 20, spd: 3, atkCooldown: 3.0, range: 3,
    cost: 5, size: 0.70, color: 0xf5a41f,
  },
  elephant: {
    id: 'elephant', name: '코끼리',
    layer: 'ground', attackLayer: 'both',
    hp: 50, atk: 6, spd: 2, atkCooldown: 1.5, range: 5,
    cost: 7, size: 0.95, color: 0x9b9b9b,
  },
  eagle: {
    id: 'eagle', name: '앵무새',
    layer: 'air', attackLayer: 'both',
    hp: 10, atk: 1, spd: 7, atkCooldown: 0.6, range: 1,
    cost: 2, size: 0.40, color: 0x4a3728,
  },
  monkey: {
    id: 'monkey', name: '원숭이',
    layer: 'ground', attackLayer: 'both',
    hp: 13, atk: 2, spd: 4, atkCooldown: 0.75, range: 10,
    cost: 3, size: 0.55, color: 0xc87941,
    ranged: true,
  },
  mole: {
    id: 'mole', name: '비버',
    layer: 'underground', attackLayer: 'ground',
    hp: 13, atk: 1, spd: 10, atkCooldown: 0.6, range: 1,
    cost: 2, size: 0.50, color: 0x7a5c40,
  },
  bee: {
    id: 'bee', name: '벌',
    layer: 'air', attackLayer: 'both',
    hp: 5, atk: 1, spd: 10, atkCooldown: 0.3, range: 4,
    cost: 1, size: 0.25, color: 0xffcc00,
    stinger: true,
  },
  bunny: {
    id: 'bunny', name: '토끼',
    layer: 'ground', attackLayer: 'ground',
    hp: 13, atk: 2, spd: 6, atkCooldown: 0.6, range: 1,
    cost: 2, size: 0.40, color: 0xf0e0d0,
    jumping: true,
  },
  cat: {
    id: 'cat', name: '고양이',
    layer: 'ground', attackLayer: 'ground',
    hp: 16, atk: 2, spd: 5, atkCooldown: 0.6, range: 2,
    cost: 3, size: 0.40, color: 0xd4a060,
    evasion: 0.5,
  },
  chick: {
    id: 'chick', name: '병아리',
    layer: 'ground', attackLayer: 'ground',
    hp: 6, atk: 0.1, spd: 8, atkCooldown: 0.3, range: 1,
    cost: 1, size: 0.25, color: 0xffe080,
    groupSpawn: 4,
  },
  cow: {
    id: 'cow', name: '소',
    layer: 'ground', attackLayer: 'ground',
    hp: 20, atk: 1, spd: 3, atkCooldown: 1.5, range: 1,
    cost: 3, size: 0.70, color: 0xd4b090,
  },
  crab: {
    id: 'crab', name: '게',
    layer: 'ground', attackLayer: 'ground',
    hp: 6, atk: 1, spd: 6, atkCooldown: 0.375, range: 1,
    cost: 1, size: 0.35, color: 0xcc4420,
  },
  deer: {
    id: 'deer', name: '사슴',
    layer: 'ground', attackLayer: 'ground',
    hp: 18, atk: 2, spd: 4, atkCooldown: 0.6, range: 1,
    cost: 3, size: 0.70, color: 0xc09060,
  },
  dog: {
    id: 'dog', name: '개',
    layer: 'ground', attackLayer: 'ground',
    hp: 16, atk: 3, spd: 5, atkCooldown: 0.5, range: 1,
    cost: 3, size: 0.55, color: 0xd4a050,
  },
  fox: {
    id: 'fox', name: '여우',
    layer: 'ground', attackLayer: 'ground',
    hp: 16, atk: 2, spd: 5, atkCooldown: 0.5, range: 1,
    cost: 2, size: 0.45, color: 0xe06030,
  },
  giraffe: {
    id: 'giraffe', name: '기린',
    layer: 'ground', attackLayer: 'both',
    hp: 16, atk: 3, spd: 5, atkCooldown: 0.75, range: 3,
    cost: 4, size: 0.95, color: 0xd4b060,
  },
  hog: {
    id: 'hog', name: '멧돼지',
    layer: 'ground', attackLayer: 'ground',
    hp: 15, atk: 1, spd: 9, atkCooldown: 0.3, range: 1,
    cost: 4, size: 0.60, color: 0x908080,
    charge: true,
  },
  koala: {
    id: 'koala', name: '코알라',
    layer: 'ground', attackLayer: 'both',
    hp: 15, atk: 5, spd: 1, atkCooldown: 3.0, range: 3,
    cost: 2, size: 0.55, color: 0xa0a0a0,
    ranged: true,
  },
  panda: {
    id: 'panda', name: '판다',
    layer: 'ground', attackLayer: 'ground',
    hp: 23, atk: 3, spd: 2, atkCooldown: 1.5, range: 1,
    cost: 3, size: 0.60, color: 0xdddddd,
  },
  penguin: {
    id: 'penguin', name: '펭귄',
    layer: 'ground', attackLayer: 'ground',
    hp: 13, atk: 1, spd: 1, atkCooldown: 0.6, range: 1,
    cost: 1, size: 0.40, color: 0x202020,
  },
  pig: {
    id: 'pig', name: '돼지',
    layer: 'ground', attackLayer: 'ground',
    hp: 20, atk: 2, spd: 3, atkCooldown: 1.0, range: 1,
    cost: 3, size: 0.55, color: 0xffaaaa,
  },
  polar: {
    id: 'polar', name: '북극곰',
    layer: 'ground', attackLayer: 'ground',
    hp: 30, atk: 6, spd: 3, atkCooldown: 1.0, range: 1,
    cost: 5, size: 0.70, color: 0xf0f0f8,
  },
  tiger: {
    id: 'tiger', name: '호랑이',
    layer: 'ground', attackLayer: 'ground',
    hp: 25, atk: 10, spd: 4, atkCooldown: 0.5, range: 2,
    cost: 6, size: 0.80, color: 0xe08030,
    leap: true,
    leapRange: 5,
  },
};

export const ANIMAL_IDS = [
  // 1-cost
  'bee', 'chick', 'crab', 'penguin',
  // 2-cost
  'bunny', 'eagle', 'fox', 'koala', 'mole',
  // 3-cost
  'cat', 'cow', 'deer', 'dog', 'monkey', 'panda', 'pig',
  // 4-cost
  'giraffe', 'hog',
  // 5-cost
  'lion', 'polar',
  // 6-cost
  'tiger',
  // 7-cost
  'elephant',
];

export const BASE_HP = 60;
export const BASE_HP_1P_ENEMY = 120;

export const FIELD_LEN = 67.5;
export const SPAWN_P1 = 4.0;
export const SPAWN_P2 = FIELD_LEN - 4.0;
export const MOLE_SURFACE_DETECT = 2.5;
export const AIR_Y = 4.0;
export const GROUND_Y = 0;
