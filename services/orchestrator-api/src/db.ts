// services/orchestrator-api/src/db.ts
import dotenv from 'dotenv';
dotenv.config();

import { Pool, PoolConfig, PoolClient } from 'pg';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import mariadb, { Pool as MariaPool } from 'mariadb';

/* =========================
 *  SUPABASE (HTTP SDK)
 * ========================= */
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!;

let _envLogged = false;
(function logOnce() {
  if (_envLogged) return;
  _envLogged = true;
  console.log('[db.env] SUPABASE_URL:', SUPABASE_URL);
  console.log('[db.env] Using key:', SUPABASE_SERVICE_KEY ? 'present' : 'missing');
  console.log('[db.env] NODE_ENV:', process.env.NODE_ENV || 'undefined');
})();

export const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  global: { fetch },
});

export async function checkPgHttp(): Promise<boolean> {
  try {
    const { data, error } = await sb.rpc('health_ping');
    if (!error && (data === 1 || data?.ok === 1)) return true;
  } catch {}
  const { error: e2 } = await sb.from('events').select('*', { count: 'exact', head: true }).limit(1);
  return !e2;
}

/* =========================
 *  POSTGRES (pg Pool)
 * ========================= */
let _pgPool: Pool | null = null;

function buildPgPool(): Pool {
  // Dê preferência a POSTGRES_URI; se ausente, tenta SUPABASE_DB_URL
  const cs = process.env.POSTGRES_URI || process.env.SUPABASE_DB_URL;
  if (!cs) {
    throw new Error(
      'POSTGRES_URI (ou SUPABASE_DB_URL) não definido. Configure em services/orchestrator-api/.env'
    );
  }

  const cfg: PoolConfig = {
    connectionString: cs,
    max: Number(process.env.PG_POOL_MAX || '10'),
  };

  // SSL: se a URL tiver sslmode=require ou se for Supabase, ativa SSL
  const mustSSL =
    /sslmode=require/i.test(cs) ||
    /\.supabase\.co[:/]/i.test(cs) ||
    /\.pooler\.supabase\.com[:/]/i.test(cs);

  if (mustSSL) {
    cfg.ssl = {
      rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED === '0' ? false : true,
    };
  }

  const pool = new Pool(cfg);

  pool.on('error', (err) => {
    console.error('[pg.pool] unexpected error on idle client:', err?.message || err);
  });

  try {
    const u = new URL(cs);
    console.log(
      `[pg.pool] using host=${u.host} db=${u.pathname.replace('/', '')} ssl=${cfg.ssl ? 'on' : 'off'} max=${cfg.max}`
    );
  } catch {
    console.log(`[pg.pool] using connectionString (ssl=${cfg.ssl ? 'on' : 'off'})`);
  }

  return pool;
}

export function getPgPool(): Pool {
  if (!_pgPool) _pgPool = buildPgPool();
  return _pgPool;
}

export const pg = {
  query: (text: string, params?: any[]) => getPgPool().query(text, params),
  connect: (): Promise<PoolClient> => getPgPool().connect(),
};

export async function checkPgTcp(): Promise<boolean> {
  const client = await getPgPool().connect();
  try {
    const r = await client.query('SELECT 1 AS ok');
    return r.rows?.[0]?.ok === 1;
  } finally {
    client.release();
  }
}

export async function closePgPool() {
  if (_pgPool) {
    try {
      await _pgPool.end();
    } catch {}
    _pgPool = null;
  }
}

/* =========================
 *  MARIA DB (SteVe)
 * ========================= */
const MARIADB_HOST = process.env.MARIADB_HOST || '127.0.0.1';
const MARIADB_PORT = Number(process.env.MARIADB_PORT || '3306');
const MARIADB_USER = process.env.MARIADB_USER || 'steve';
const MARIADB_PASSWORD = process.env.MARIADB_PASSWORD || 'steve';
const MARIADB_DATABASE = process.env.MARIADB_DATABASE || 'steve';

let _mdbPool: MariaPool | null = null;

export function getMariaPool(): MariaPool {
  if (!_mdbPool) {
    _mdbPool = mariadb.createPool({
      host: MARIADB_HOST,
      port: MARIADB_PORT,
      user: MARIADB_USER,
      password: MARIADB_PASSWORD,
      database: MARIADB_DATABASE,
      connectionLimit: 5,
      acquireTimeout: 15_000,
      connectTimeout: 8_000,
      socketTimeout: 8_000,
    });
  }
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
  try {
    if (_mdbPool) await _mdbPool.end();
  } catch {}
  _mdbPool = null;

  await closePgPool();
}
