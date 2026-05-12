import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string ?? '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string ?? '';

if (!url || !key) console.error('[Supabase] env vars missing — login will not work');

export const supabase = createClient(url || 'https://placeholder.supabase.co', key || 'placeholder');

const DOMAIN = '@zoobattle.local';
export const toEmail = (username: string) => `${username}${DOMAIN}`;

export const DEFAULT_DECK = ['crab', 'eagle', 'bunny', 'monkey', 'giraffe', 'polar'];
export const ALL_ANIMALS = [
  'bee','chick','crab','penguin','bunny','eagle','fox','koala','mole',
  'cat','cow','deer','dog','monkey','panda','pig','giraffe','hog',
  'lion','polar','tiger','elephant',
  // Food magic items (treated as deckable items alongside animals)
  'apple','apple_green','avocado','banana','coconut','orange','pumpkin','tomato',
  'broccoli','carrot','eggplant','lettuce','mushroom','pepper_green','pepper_red',
  'turnip','egg',
];

export interface UserProfile {
  gold: number;
  deck: string[];
  owned_animals: string[];
}

export async function loadProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error || !data) return null;
  return { gold: data.gold ?? 0, deck: data.deck ?? DEFAULT_DECK, owned_animals: data.owned_animals ?? DEFAULT_DECK };
}

export async function saveProfile(userId: string, profile: UserProfile): Promise<{ ok: boolean; message?: string }> {
  console.log('[saveProfile] upsert start', { userId, gold: profile.gold, deckLen: profile.deck.length, ownedLen: profile.owned_animals.length });
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: userId, ...profile }, { onConflict: 'id' })
    .select();
  if (error) {
    console.error('[saveProfile] FAILED', error.code, error.message, error.details, error.hint);
    return { ok: false, message: `${error.code}: ${error.message}` };
  }
  console.log('[saveProfile] OK');
  return { ok: true };
}

export async function ensureProfile(userId: string): Promise<UserProfile> {
  const existing = await loadProfile(userId);
  if (existing) return existing;
  const fresh: UserProfile = { gold: 0, deck: [...DEFAULT_DECK], owned_animals: [...DEFAULT_DECK] };
  await supabase.from('profiles').insert({ id: userId, ...fresh });
  return fresh;
}

// Persistent device token — used to prevent nickname hijacking
function getDeviceToken(): string {
  const key = 'zoo_device_token';
  let token = localStorage.getItem(key);
  if (!token) {
    token = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, token);
  }
  return token;
}

export interface LeaderboardEntry {
  nickname: string;
  word_count: number;
  clear_count: number;
  best_time: number | null;
  updated_at: string;
  wrong_count: number;
  total_words: number;
  rounds_completed: number;
}

// IMPORTANT: Run this SQL in Supabase Dashboard > SQL Editor before using these fields:
// ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS wrong_count INTEGER DEFAULT 0;
// ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS total_words INTEGER DEFAULT 0;
// ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS rounds_completed INTEGER DEFAULT 0;

export async function submitLeaderboard(
  nickname: string,
  wordCount: number,
  isWin: boolean,
  clearTimeSec: number | null,
  wrongCount: number = 0,
  totalWords: number = 0,
  roundsCompleted: number = 0
): Promise<void> {
  const deviceToken = getDeviceToken();

  // Fetch existing record
  const { data: existing } = await supabase
    .from('leaderboard')
    .select('*')
    .eq('nickname', nickname)
    .maybeSingle();

  const prev = existing as (LeaderboardEntry & { device_token?: string }) | null;

  // Block if a different device already owns this nickname
  if (prev?.device_token && prev.device_token !== deviceToken) {
    console.warn('[Leaderboard] 닉네임이 이미 다른 기기에서 사용 중입니다:', nickname);
    return;
  }

  const newWordCount = Math.max(wordCount, prev?.word_count ?? 0);
  const newClearCount = (prev?.clear_count ?? 0) + (isWin ? 1 : 0);
  const newBestTime = isWin && clearTimeSec !== null
    ? (prev?.best_time ? Math.min(prev.best_time, clearTimeSec) : clearTimeSec)
    : (prev?.best_time ?? null);
  const newWrongCount = Math.max(wrongCount, prev?.wrong_count ?? 0);
  const newTotalWords = Math.max(totalWords, prev?.total_words ?? 0);
  const newRoundsCompleted = Math.max(roundsCompleted, prev?.rounds_completed ?? 0);

  const { error } = await supabase.from('leaderboard').upsert({
    nickname,
    device_token: deviceToken,
    word_count: newWordCount,
    clear_count: newClearCount,
    best_time: newBestTime,
    wrong_count: newWrongCount,
    total_words: newTotalWords,
    rounds_completed: newRoundsCompleted,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('[Leaderboard] 저장 실패:', error.message, error.details);
  else console.log('[Leaderboard] 저장 성공:', nickname, { wordCount: newWordCount, clearCount: newClearCount, bestTime: newBestTime });
}

export async function deleteMyLeaderboard(nickname: string): Promise<boolean> {
  const deviceToken = getDeviceToken();
  const { data: existing } = await supabase
    .from('leaderboard')
    .select('device_token')
    .eq('nickname', nickname)
    .maybeSingle();
  if (!existing) return false;
  if (existing.device_token && existing.device_token !== deviceToken) return false; // 본인 아님
  const { error } = await supabase.from('leaderboard').delete().eq('nickname', nickname);
  return !error;
}

export async function fetchLeaderboard(
  sortBy: 'word_count' | 'clear_count'
): Promise<LeaderboardEntry[]> {
  const { data, error } = await supabase
    .from('leaderboard')
    .select('*')
    .order(sortBy, { ascending: false })
    .limit(100);
  if (error) {
    console.warn('[Leaderboard] fetch failed — make sure the "leaderboard" table exists in Supabase:', error.message);
    return [];
  }
  return (data ?? []) as LeaderboardEntry[];
}

// ─── Redeem Code ──────────────────────────────────────────────────────────────
export type RedeemResult =
  | { ok: true; gold: number }
  | { ok: false; reason: 'not_found' | 'already_used' | 'expired' | 'not_logged_in' | 'error' };

export async function redeemCode(code: string): Promise<RedeemResult> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'not_logged_in' };

  const { data, error } = await supabase
    .from('redeem_codes')
    .select('*')
    .eq('code', code.toUpperCase())
    .maybeSingle();

  if (error || !data) return { ok: false, reason: 'not_found' };
  if (data.used)       return { ok: false, reason: 'already_used' };
  if (data.expires_at && new Date(data.expires_at) < new Date())
    return { ok: false, reason: 'expired' };

  const { error: updErr } = await supabase
    .from('redeem_codes')
    .update({ used: true })
    .eq('code', code.toUpperCase());

  if (updErr) return { ok: false, reason: 'error' };
  return { ok: true, gold: data.gold };
}
