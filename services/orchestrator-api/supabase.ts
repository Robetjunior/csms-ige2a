// src/supabase.ts
import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Além do .env local, tenta carregar o .env da raiz do projeto
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), override: false });

const SUPABASE_URL = process.env.SUPABASE_URL;
// Exigir chave de serviço (service_role). Não usar ANON no backend.
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  undefined;

// Se houver apenas ANON_KEY, desabilitar o cliente para evitar falta de permissões (sequências, RLS, etc.)
if (!SUPABASE_SERVICE_KEY && process.env.SUPABASE_ANON_KEY) {
  console.warn('[supabase] service_role key ausente; ANON_KEY detectada. Cliente Supabase (HTTP) desativado para evitar erros de permissão.');
}

export const sb = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false },
      global: { headers: { 'X-Client-Info': 'csms-orchestrator/1.0' } },
    })
  : null as any;

// RPCs no public:
export async function checkSupabase() {
  if (!sb) return { ok: false, error: new Error('sb_unavailable') };
  const { data, error } = await sb.rpc('health_ping');
  return { ok: error == null && data === 1, error };
}
