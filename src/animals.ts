export type AnimalLayer = 'ground' | 'air' | 'underground';
export type AttackLayer = 'ground' | 'air' | 'both';

export interface AnimalDef {
  id: string;
  name: string;
  layer: AnimalLayer;
  attackLayer: AttackLayer;
  hp: number;
  atk: number;
  spd: number;         // units/sec (underground spd = spd * 2 for mole)
  atkCooldown: number; // seconds
  range: number;       // attack range in world units
  cost: number;        // currency cost
  size: number;        // box half-size
  color: number;       // hex color
  ranged?: boolean;    // monkey: stops at range distance, never retreats
}

// All stats tuned so base HP 30 = ~3 lion hits or 30 mouse hits
export const ANIMALS: Record<string, AnimalDef> = {
  lion: {
    id: 'lion', name: '사자',
    layer: 'ground', attackLayer: 'ground',
    hp: 25, atk: 10, spd: 1.5, atkCooldown: 1.0, range: 2.0,
    cost: 4, size: 0.65, color: 0xf5a41f,
  },
  elephant: {
    id: 'elephant', name: '코끼리',
    layer: 'ground', attackLayer: 'both',
    hp: 50, atk: 6, spd: 1.0, atkCooldown: 1.5, range: 3.0,
    cost: 5, size: 1.0, color: 0x9b9b9b,
  },
  mouse: {
    id: 'mouse', name: '토끼',
    layer: 'ground', attackLayer: 'ground',
    hp: 8, atk: 1, spd: 4.0, atkCooldown: 0.3, range: 1.2,
    cost: 1, size: 0.4, color: 0xf0e0d0,
  },
  eagle: {
    id: 'eagle', name: '앵무새',
    layer: 'air', attackLayer: 'both',
    hp: 15, atk: 4, spd: 2.5, atkCooldown: 0.6, range: 2.5,
    cost: 3, size: 0.5, color: 0x4a3728,
  },
  monkey: {
    id: 'monkey', name: '원숭이',
    layer: 'ground', attackLayer: 'both',
    hp: 20, atk: 2, spd: 2.0, atkCooldown: 0.75, range: 8.0,
    cost: 3, size: 0.55, color: 0xc87941,
    ranged: true,
  },
  mole: {
    id: 'mole', name: '비버',
    layer: 'underground', attackLayer: 'ground',
    hp: 10, atk: 2, spd: 5.0, atkCooldown: 0.6, range: 1.5,
    cost: 2, size: 0.4, color: 0x7a5c40,
  },
};

export const ANIMAL_IDS = ['lion', 'elephant', 'mouse', 'eagle', 'monkey', 'mole'];

// Base HP = 30 (in same units as atk)
// 1P enemy base HP = 60
export const BASE_HP = 30;
export const BASE_HP_1P_ENEMY = 60;

// Field constants (shared between client and server)
export const FIELD_LEN = 45;
export const SPAWN_P1 = 2.5;
export const SPAWN_P2 = FIELD_LEN - 2.5;
export const MOLE_SURFACE_DETECT = 2.5; // mole surfaces if enemy within this Z distance
export const AIR_Y = 4.0;
export const GROUND_Y = 0;
