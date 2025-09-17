// src/supabase.ts
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

export const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  global: { headers: { 'X-Client-Info': 'csms-orchestrator/1.0' } },
});

// RPCs no public:
export async function checkSupabase() {
  const { data, error } = await sb.rpc('health_ping');
  return { ok: error == null && data === 1, error };
}
