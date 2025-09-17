// src/db.ts
import dotenv from 'dotenv';
dotenv.config();

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import mariadb, { Pool as MariaPool } from 'mariadb';

// ✅ ADD: node-postgres
import {
  Pool as PgPool,
  PoolClient as PgPoolClient,
  types as pgTypes,
  QueryResult,
  QueryResultRow,
} from 'pg';

/* -------------------- LOG ENV -------------------- */
let envLogged = false;
(function logDbEnvOnce() {
  if (envLogged) return;
  envLogged = true;
  console.log('[db.env] SUPABASE_URL:', process.env.SUPABASE_URL);
  console.log('[db.env] Using key:', (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY) ? 'present' : 'missing');
  console.log('[db.env] NODE_ENV:', process.env.NODE_ENV || 'undefined');
})();

/* -------------------- SUPABASE (HTTP) -------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY!;

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

/* -------------------- POSTGRES (node-postgres) -------------------- */
// Dica: para Supabase ou PG gerenciado, normalmente precisa de SSL.
const PG_URL =
  process.env.PG_URL ||
  process.env.DATABASE_URL || // compatível com plataformas PaaS
  undefined;

const PGHOST = process.env.PGHOST;
const PGPORT = process.env.PGPORT ? Number(process.env.PGPORT) : undefined;
const PGUSER = process.env.PGUSER;
const PGPASSWORD = process.env.PGPASSWORD;
const PGDATABASE = process.env.PGDATABASE;
const PGSSL = (process.env.PG_SSL ?? 'true').toLowerCase() !== 'false'; // default true

// Constrói config quando não há URL única
const pgConnConfig = PG_URL
  ? { connectionString: PG_URL, ssl: PGSSL ? { rejectUnauthorized: false } : undefined }
  : {
      host: PGHOST,
      port: PGPORT,
      user: PGUSER,
      password: PGPASSWORD,
      database: PGDATABASE,
      ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
    };

// Ajuste de parsers: int8/bigint -> number (se couber)
pgTypes.setTypeParser(20, (v: string) => {
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
});

let _pgPool: PgPool | null = null;
function getPgPool(): PgPool {
  if (!_pgPool) {
    _pgPool = new PgPool(pgConnConfig as any);
    _pgPool.on('error', (err) => {
      console.error('[pg] pool error:', err?.message || err);
    });
  }
  return _pgPool;
}

export interface PgWrapper {
  query<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<QueryResult<T>>;
  connect(): Promise<PgPoolClient>;
}

export const pg: PgWrapper = {
  query: (text, params) => getPgPool().query(text, params),
  connect: () => getPgPool().connect(),
};

// Health check SQL direto
export async function checkPgSql(): Promise<boolean> {
  try {
    const r = await pg.query<{ ok: number }>('select 1 as ok');
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/* -------------------- MariaDB (SteVe) -------------------- */
const MARIADB_HOST = process.env.MARIADB_HOST || '127.0.0.1';
const MARIADB_PORT = Number(process.env.MARIADB_PORT || '3307');
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
      await new Promise(r => setTimeout(r, 1000));
    } finally {
      if (conn) conn.release();
    }
  }
  throw lastErr;
}

export async function closeDbPools() {
  try { if (_mdbPool) await _mdbPool.end(); } catch {}
  _mdbPool = null;

  try { if (_pgPool) await _pgPool.end(); } catch {}
  _pgPool = null;
}
