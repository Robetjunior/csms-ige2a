// services/orchestrator-api/src/db.ts
import dotenv from 'dotenv';
dotenv.config();

import dns from 'dns';
import { Pool, PoolConfig, PoolClient, QueryResult, QueryResultRow } from 'pg';
import mariadb, { Pool as MariaPool } from 'mariadb';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/* =====================================================================================
 * Logs “seguros” de ambiente (não vaza segredo)
 * ===================================================================================*/
let envLogged = false;
(function logDbEnvOnce() {
  if (envLogged) return;
  envLogged = true;

  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
  const nodeEnv = process.env.NODE_ENV || 'undefined';

  console.log('[db.env] SUPABASE_URL:', SUPABASE_URL || '(none)');
  console.log('[db.env] Using key:', hasServiceKey ? 'present' : 'missing');
  console.log('[db.env] NODE_ENV:', nodeEnv);
})();

/* =====================================================================================
 * Supabase (HTTP SDK) – opcional, usado para RPC/Storage/etc.
 * ===================================================================================*/
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY)!;

export const sb: SupabaseClient = createClient(SB_URL, SB_KEY, {
  auth: { persistSession: false },
  global: { fetch }, // Node 18+/20+ já tem fetch
});

/**
 * Healthcheck HTTP no Supabase (RPC “health_ping” se existir; senão HEAD count leve).
 */
export async function checkPgHttp(): Promise<boolean> {
  try {
    const { data, error } = await sb.rpc('health_ping');
    if (!error && (data === 1 || (data && (data as any).ok === 1))) return true;
  } catch {
    // continua para o fallback
  }
  const { error: e2 } = await sb.from('events').select('*', { count: 'exact', head: true }).limit(1);
  return !e2;
}

/* =====================================================================================
 * Postgres (node-postgres / pg) – pool único, com suporte a IPv4-forçado
 * ===================================================================================*/
let _pgPool: Pool | null = null;

function boolEnv(name: string, def = false): boolean {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
}

function getPostgresUri(): string {
  // Prioridade: POSTGRES_URI (recomendado) → SUPABASE_DB_URL → default local dev
  const fromEnv = process.env.POSTGRES_URI || process.env.SUPABASE_DB_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // Fallback local (dev)
  return 'postgresql://csms:csms@postgres:5432/csms';
}

export function getPgPool(): Pool {
  if (_pgPool) return _pgPool;

  const connStr = getPostgresUri();
  const url = new URL(connStr);

  // SSL: usa sslmode=require do connection string ou força via env
  const sslmode = url.searchParams.get('sslmode'); // e.g. require
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

  // ⭐ Se PG_FORCE_IPV4=1, força resolução DNS apenas IPv4 (evita tentativas AAAA/IPv6)
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
  console.log(
    `[pg.pool] using host=${host}:${port} db=${db} ssl=${wantSSL ? 'on' : 'off'} max=${max}`
  );
  if ((process.env.PG_FORCE_IPV4 || '0') === '1') {
    console.log('[pg.pool] forcing IPv4 lookup');
  }

  _pgPool = new Pool(cfg);

  _pgPool.on('error', (err) => {
    console.error('[pg.pool] Pool error:', err?.message || err);
  });

  return _pgPool;
}

/**
 * Wrapper compatível com o repo.ts
 */
export const pg = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> =>
    getPgPool().query<T>(text, params),

  connect: (): Promise<PoolClient> =>
    getPgPool().connect(),
};

/* =====================================================================================
 * MariaDB (SteVe) – opcional
 * ===================================================================================*/
const MARIADB_HOST = process.env.MARIADB_HOST || '127.0.0.1';
const MARIADB_PORT = Number(process.env.MARIADB_PORT || '3307');
const MARIADB_USER = process.env.MARIADB_USER || 'steve';
const MARIADB_PASSWORD = process.env.MARIADB_PASSWORD || 'steve';
const MARIADB_DATABASE = process.env.MARIADB_DATABASE || 'steve';

let _mdbPool: MariaPool | null = null;

export function getMariaPool(): MariaPool {
  if (_mdbPool) return _mdbPool;
  _mdbPool = mariadb.createPool({
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    password: MARIADB_PASSWORD,
    database: MARIADB_DATABASE,
    connectionLimit: Number(process.env.MARIA_POOL_MAX || '5') || 5,
    acquireTimeout: 15_000,
    connectTimeout: 8_000,
    socketTimeout: 8_000,
    timezone: 'Z',
  });
  return _mdbPool;
}

export async function checkMaria(retries = 2): Promise<boolean> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    let conn: any;
    try {
      conn = await getMariaPool().getConnection();
      const rows = await conn.query('SELECT 1 AS ok');
      return rows?.[0]?.ok === 1 || rows?.[0]?.['1'] === 1;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      if (conn) conn.release();
    }
  }
  throw lastErr;
}

export async function closeDbPools() {
  try { if (_mdbPool) await _mdbPool.end(); } catch {}
  try { if (_pgPool)  await _pgPool.end();  } catch {}
  _mdbPool = null;
  _pgPool = null;
}
