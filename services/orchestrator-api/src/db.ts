import { Pool as PgPool } from 'pg';
import mariadb from 'mariadb';

const pgUri = process.env.POSTGRES_URI || 'postgresql://csms:csms@localhost:5432/csms';

export const pg = new PgPool({ connectionString: pgUri });

const MARIADB_HOST = process.env.MARIADB_HOST || '127.0.0.1';
const MARIADB_PORT = Number(process.env.MARIADB_PORT || '3306');
const MARIADB_USER = process.env.MARIADB_USER || 'steve';
const MARIADB_PASSWORD = process.env.MARIADB_PASSWORD || 'steve';
const MARIADB_DATABASE = process.env.MARIADB_DATABASE || 'steve';

// pool com timeouts razoáveis
export const mdbPool = mariadb.createPool({
  host: MARIADB_HOST,
  port: MARIADB_PORT,
  user: MARIADB_USER,
  password: MARIADB_PASSWORD,
  database: MARIADB_DATABASE,
  connectionLimit: 5,
  acquireTimeout: 15000, 
  connectTimeout: 8000,  
  socketTimeout: 8000
});

export async function checkPg() {
  const res = await pg.query('select 1 as ok');
  return res.rows[0]?.ok === 1;
}

// retry simples para cold start
export async function checkMaria(retries = 2): Promise<boolean> {
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    let conn;
    try {
      conn = await mdbPool.getConnection();
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
