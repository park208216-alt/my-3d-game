import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, key);

// Supabase auth uses email internally; we append a fixed domain so users just type a username
const DOMAIN = '@zoobattle.local';
export const toEmail = (username: string) => `${username}${DOMAIN}`;
