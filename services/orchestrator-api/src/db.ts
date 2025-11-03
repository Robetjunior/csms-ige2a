import dotenv from 'dotenv';
import path from 'node:path';
// Carrega .env local e também tenta carregar o .env da raiz do projeto
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), override: false });

import dns from 'dns';
import { Pool, PoolConfig, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/* Log leve do ambiente (sem segredos) */
let envLogged = false;
(function logDbEnvOnce() {
  if (envLogged) return;
  envLogged = true;
  const hasSbUrl = Boolean(process.env.SUPABASE_URL);
  const hasSbKey = Boolean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  console.log('[db.env] SUPABASE configured:', hasSbUrl && hasSbKey ? 'yes' : 'no');
  console.log('[db.env] NODE_ENV:', process.env.NODE_ENV || 'undefined');
  // Diagnóstico fino de SSL/PG
  console.log('[db.env] PG_SSL:', process.env.PG_SSL ?? '(unset)');
  console.log('[db.env] PG_SSL_ENABLED:', process.env.PG_SSL_ENABLED ?? '(unset)');
  console.log('[db.env] PG_SSL_REJECT_UNAUTHORIZED:', process.env.PG_SSL_REJECT_UNAUTHORIZED ?? '(unset)');
  console.log('[db.env] POSTGRES_URI set:', Boolean(process.env.POSTGRES_URI) ? 'yes' : 'no');
  console.log('[db.env] SUPABASE_DB_URL set:', Boolean(process.env.SUPABASE_DB_URL) ? 'yes' : 'no');
})();

/* Supabase (HTTP SDK) — opcional */
export const sb: SupabaseClient | null = (() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false }, global: { fetch } });
})();

/* Postgres (Supabase) via 'pg' */
let _pgPool: Pool | null = null;

function boolEnv(name: string, def = false): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
}

function getPostgresUri(): string {
  const fromEnv = process.env.POSTGRES_URI || process.env.SUPABASE_DB_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  throw new Error('POSTGRES_URI ou SUPABASE_DB_URL não configurados (Supabase only).');
}

export function getPgPool(): Pool {
  if (_pgPool) return _pgPool;

  const connStr = getPostgresUri();
  const url = new URL(connStr);

  const sslmode = url.searchParams.get('sslmode'); // ex.: require
  const wantSSL = sslmode === 'require' || boolEnv('PG_SSL', false) || boolEnv('PG_SSL_ENABLED', false);
  const rejectUnauth = (process.env.PG_SSL_REJECT_UNAUTHORIZED || '1') !== '0';

  const max = Number(process.env.PG_POOL_MAX || '10') || 10;
  const idleTimeoutMillis = Number(process.env.PG_IDLE_TIMEOUT_MS || '30000') || 30000;
  const connectionTimeoutMillis = Number(process.env.PG_CONNECT_TIMEOUT_MS || '10000') || 10000;

  const cfg: PoolConfig = {
    connectionString: connStr,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  };

  if (wantSSL) {
    (cfg as any).ssl = { rejectUnauthorized: rejectUnauth };
  }

  if ((process.env.PG_FORCE_IPV4 || '0') === '1') {
    (cfg as any).lookup = (
      hostname: string,
      options: any,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
    ) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      dns.lookup(hostname, { family: 4, all: false }, callback as any);
    };
  }

  const host = url.hostname;
  const port = Number(url.port || '5432');
  const db = url.pathname?.replace(/^\//, '') || '(default)';
  console.log(`[pg.pool] using host=${host}:${port} db=${db} ssl=${wantSSL ? 'on' : 'off'} max=${max}`);

  _pgPool = new Pool(cfg);
  _pgPool.on('error', (err) => console.error('[pg.pool] Pool error:', err?.message || err));
  return _pgPool;
}

export const pg = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> =>
    getPgPool().query<T>(text, params),
  connect: (): Promise<PoolClient> => getPgPool().connect(),
};

export async function checkPg(): Promise<boolean> {
  try {
    const r = await pg.query<{ ok: number }>('SELECT 1 AS ok');
    return r.rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function checkPgHttp(): Promise<boolean> {
  // Prioriza checar o Postgres do Supabase via pool
  const okLocal = await checkPg();
  if (okLocal) return true;

  // fallback: se sb existir, testa uma requisição HEAD leve
  if (sb) {
    try {
      const { error } = await sb.from('events').select('*', { count: 'exact', head: true }).limit(1);
      return !error;
    } catch {}
  }
  return false;
}

export async function closeDbPools() {
  try { if (_pgPool) await _pgPool.end(); } catch {}
  _pgPool = null;
}
