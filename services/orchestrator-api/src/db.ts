// services/orchestrator-api/src/db.ts
import dotenv from 'dotenv';
dotenv.config();

import { Pool as PgPool } from 'pg';
import mariadb, { Pool as MariaPool } from 'mariadb';

const POSTGRES_URI = process.env.POSTGRES_URI || 'postgresql://csms:csms@localhost:5432/csms';

const MARIADB_HOST = process.env.MARIADB_HOST || '127.0.0.1';
const MARIADB_PORT = Number(process.env.MARIADB_PORT || '3307');
const MARIADB_USER = process.env.MARIADB_USER || 'steve';
const MARIADB_PASSWORD = process.env.MARIADB_PASSWORD || 'steve';
const MARIADB_DATABASE = process.env.MARIADB_DATABASE || 'steve';

let envLogged = false;
function logDbEnvOnce() {
  if (envLogged) return;
  envLogged = true;
  console.log('[db.env] POSTGRES_URI:', POSTGRES_URI.replace(/:[^:@/]+@/, ':***@'));
  console.log('[db.env] MARIADB:', {
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    database: MARIADB_DATABASE,
    nodeEnv: process.env.NODE_ENV || 'undefined'
  });
}
logDbEnvOnce();

// --- Postgres pool (sempre precisamos) ---
export const pg = new PgPool({ connectionString: POSTGRES_URI });

// --- MariaDB pool (lazy) ---
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
      acquireTimeout: 15000,
      connectTimeout: 8000,
      socketTimeout: 8000,
    });
  }
  return _mdbPool;
}

// --- health checks ---
export async function checkPg() {
  const res = await pg.query('select 1 as ok');
  return res.rows[0]?.ok === 1;
}

export async function checkMaria(retries = 2): Promise<boolean> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    let conn;
    try {
      conn = await getMariaPool().getConnection();
      const rows = await conn.query('select 1 as ok');
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
  try { await pg.end(); } catch {}
  try { if (_mdbPool) await _mdbPool.end(); } catch {}
  _mdbPool = null;
}
