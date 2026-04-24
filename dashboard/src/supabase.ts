import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — set them in .env or Vercel dashboard');
}

export const supabase = createClient(url || 'https://placeholder.supabase.co', key || 'placeholder');
export const isConfigured = !!(url && key);
