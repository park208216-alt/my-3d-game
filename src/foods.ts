// Food magic items — used like animal summons but produce projectile/area effects.
// Sizes are based on real-world dimensions, scaled into game units (animal size 0.15 ≈ 6cm).

export type FoodEffect =
  | 'apple_buff'        // homes to ally closest to base, +ATK +ATKSPD ×2, size ×2
  | 'green_apple_buff'  // homes to ally closest to base, +HP +SPD ×2, size ×2
  | 'avocado_slow'      // parabolic, plants pit → 5s slow zone (radius 4)
  | 'banana_boomerang'  // straight at farthest enemy, returns to base (damages on return)
  | 'coconut_drop'      // 5 coconuts fall from sky at random positions, AOE damage
  | 'orange_volley'     // 5 oranges, parabolic homing to nearest enemies
  | 'pumpkin_roll'      // 3 pumpkins roll forward, knock down enemies
  | 'tomato_lob'        // 6 tomatoes lobbed at enemy base area, slow projectile
  | 'broccoli_barrier'  // single barrier at farthest ally pos, 30 HP, 5s
  | 'carrot_spikes'     // 7 carrots erupt from ground, 3s persistent damage
  | 'eggplant_dot'      // parabolic to nearest enemy, creates 5s purple DOT zone
  | 'lettuce_mines'     // 5 lettuces grow, explode on enemy contact (AOE)
  | 'mushroom_paralyze' // 6 mushrooms across field, 2s paralyze on contact
  | 'pepper_green_heal' // 3 peppers, each homes to a different ally, HoT
  | 'pepper_red_dot'    // 4 peppers, each homes to a different enemy, DOT
  | 'turnip_uppercut'   // 5 turnips erupt vertically, gravity returns, repeat hits
  | 'egg_drop';         // 5 eggs as mortar projectiles, 50% chance to spawn ally chick

export interface FoodDef {
  id: string;
  name: string;       // Korean
  fbxFile: string;    // file in public/food/FBX/
  size: number;       // visual scale multiplier (relative to animal sizes)
  cost: number;       // mana cost (matches animal cost system)
  color: number;      // for card UI fallback
  count: number;      // how many projectiles spawn (multi-shot)
  damage?: number;    // base damage (for damaging foods)
  duration?: number;  // effect duration in seconds (for buffs/zones)
  aoe?: number;       // splash radius (for AOE foods)
  desc: string;       // Korean description for deck UI
  effect: FoodEffect;
}

export const FOODS: Record<string, FoodDef> = {
  apple: {
    id: 'apple', name: '사과', fbxFile: 'Apple.fbx',
    size: 0.18, cost: 5, color: 0xcc2222, count: 1,
    desc: '아군 1명에게 공격력+공속 2배 (영구)', effect: 'apple_buff',
  },
  apple_green: {
    id: 'apple_green', name: '초록사과', fbxFile: 'Apple_Green.fbx',
    size: 0.18, cost: 5, color: 0x66cc22, count: 1,
    desc: '아군 1명에게 체력+이동속도 2배 (영구)', effect: 'green_apple_buff',
  },
  avocado: {
    id: 'avocado', name: '아보카도', fbxFile: 'Avocado.fbx',
    size: 0.20, cost: 4, color: 0x556b2f, count: 1,
    duration: 5, aoe: 4,
    desc: '5초 동안 적 이동속도 60% 감소 구역 생성', effect: 'avocado_slow',
  },
  banana: {
    id: 'banana', name: '바나나', fbxFile: 'Banana.fbx',
    size: 0.22, cost: 3, color: 0xffe040, count: 1, damage: 8,
    desc: '회전하며 가장 먼 적까지 갔다가 부메랑처럼 복귀', effect: 'banana_boomerang',
  },
  coconut: {
    id: 'coconut', name: '코코넛', fbxFile: 'Coconut.fbx',
    size: 0.23, cost: 4, color: 0x6b4423, count: 5, damage: 12, aoe: 2,
    desc: '코코넛 5개가 무작위 위치로 떨어져 범위 피해', effect: 'coconut_drop',
  },
  orange: {
    id: 'orange', name: '오렌지', fbxFile: 'Orange.fbx',
    size: 0.18, cost: 2, color: 0xffa500, count: 5, damage: 4,
    desc: '오렌지 5개가 적을 유도하며 단일 피해', effect: 'orange_volley',
  },
  pumpkin: {
    id: 'pumpkin', name: '호박', fbxFile: 'Pumpkin.fbx',
    size: 0.50, cost: 4, color: 0xff8c00, count: 3, damage: 15,
    desc: '호박 3개가 기지 앞으로 굴러가며 큰 피해', effect: 'pumpkin_roll',
  },
  tomato: {
    id: 'tomato', name: '토마토', fbxFile: 'Tomato.fbx',
    size: 0.16, cost: 2, color: 0xdc143c, count: 6, damage: 3,
    desc: '토마토 6개가 적 기지 앞에 포물선으로 떨어짐', effect: 'tomato_lob',
  },
  broccoli: {
    id: 'broccoli', name: '브로콜리', fbxFile: 'Broccoli.fbx',
    size: 0.38, cost: 4, color: 0x228b22, count: 1,
    duration: 5,
    desc: '5초 방벽 (체력 30, 동시 1개 한정)', effect: 'broccoli_barrier',
  },
  carrot: {
    id: 'carrot', name: '당근', fbxFile: 'Carrot.fbx',
    size: 0.20, cost: 3, color: 0xff8000, count: 7, damage: 5,
    duration: 3,
    desc: '당근 7개가 솟아 3초간 닿는 적에게 피해', effect: 'carrot_spikes',
  },
  eggplant: {
    id: 'eggplant', name: '가지', fbxFile: 'Eggplant.fbx',
    size: 0.23, cost: 4, color: 0x6a0dad, count: 1, damage: 5,
    duration: 5, aoe: 3,
    desc: '땅에 닿으면 5초 보라 DOT 구역 (1초당 5피해)', effect: 'eggplant_dot',
  },
  lettuce: {
    id: 'lettuce', name: '상추', fbxFile: 'Lettuce_Whole.fbx',
    size: 0.30, cost: 4, color: 0x90ee90, count: 5, damage: 12,
    duration: 5, aoe: 2,
    desc: '상추 5개가 솟아 적과 닿으면 폭발 (광역)', effect: 'lettuce_mines',
  },
  mushroom: {
    id: 'mushroom', name: '버섯', fbxFile: 'Mushroom.fbx',
    size: 0.18, cost: 3, color: 0xb22222, count: 6,
    duration: 2,
    desc: '버섯 6개가 솟아 닿는 적을 2초간 마비', effect: 'mushroom_paralyze',
  },
  pepper_green: {
    id: 'pepper_green', name: '초록 피망', fbxFile: 'Pepper_Green.fbx',
    size: 0.19, cost: 3, color: 0x32cd32, count: 3,
    duration: 3,
    desc: '아군 3명에게 3초간 1초당 10 회복', effect: 'pepper_green_heal',
  },
  pepper_red: {
    id: 'pepper_red', name: '빨간 피망', fbxFile: 'Pepper_Red.fbx',
    size: 0.19, cost: 3, color: 0xb22222, count: 4, damage: 10,
    duration: 3,
    desc: '적 4명에게 3초간 1초당 10 피해', effect: 'pepper_red_dot',
  },
  turnip: {
    id: 'turnip', name: '순무', fbxFile: 'Turnip.fbx',
    size: 0.24, cost: 3, color: 0xeeb4b4, count: 5, damage: 8,
    desc: '순무 5개가 솟구쳐 올라 닿는 적에게 반복 피해', effect: 'turnip_uppercut',
  },
  egg: {
    id: 'egg', name: '달걀', fbxFile: 'Egg_Whole.fbx',
    size: 0.15, cost: 2, color: 0xfffaf0, count: 5, damage: 3,
    desc: '달걀 5개가 박격포처럼 떨어짐 (50% 확률 병아리 소환)', effect: 'egg_drop',
  },
};

export const FOOD_IDS: string[] = [
  // 2-cost (cheap utility)
  'orange', 'tomato', 'egg',
  // 3-cost
  'banana', 'carrot', 'mushroom', 'pepper_green', 'pepper_red', 'turnip',
  // 4-cost
  'avocado', 'coconut', 'pumpkin', 'broccoli', 'eggplant', 'lettuce',
  // 5-cost (powerful buffs)
  'apple', 'apple_green',
];

export function isFoodId(id: string): boolean {
  return id in FOODS;
}
