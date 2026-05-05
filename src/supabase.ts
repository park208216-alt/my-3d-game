import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string ?? '';
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string ?? '';

if (!url || !key) console.error('[Supabase] env vars missing — login will not work');

export const supabase = createClient(url || 'https://placeholder.supabase.co', key || 'placeholder');

const DOMAIN = '@zoobattle.local';
export const toEmail = (username: string) => `${username}${DOMAIN}`;
