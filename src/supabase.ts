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
];

export interface UserProfile {
  gold: number;
  deck: string[];
  owned_animals: string[];
}

export async function loadProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error || !data) return null;
  return { gold: data.gold ?? 0, deck: data.deck ?? DEFAULT_DECK, owned_animals: data.owned_animals ?? ALL_ANIMALS };
}

export async function saveProfile(userId: string, profile: UserProfile): Promise<boolean> {
  const { error } = await supabase.from('profiles').upsert({ id: userId, ...profile });
  return !error;
}

export async function ensureProfile(userId: string): Promise<UserProfile> {
  const existing = await loadProfile(userId);
  if (existing) return existing;
  const fresh: UserProfile = { gold: 0, deck: [...DEFAULT_DECK], owned_animals: [...ALL_ANIMALS] };
  await supabase.from('profiles').insert({ id: userId, ...fresh });
  return fresh;
}
