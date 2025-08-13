import { Pool as PgPool } from 'pg';
import mariadb from 'mariadb';

const pgUri = process.env.POSTGRES_URI || 'postgresql://csms:csms@localhost:5432/csms';
const mdbUri = process.env.MARIADB_URI || 'mariadb://steve:steve@localhost:3306/steve';

export const pg = new PgPool({ connectionString: pgUri });
export const mdbPool = mariadb.createPool({
  host: 'localhost',
  port: 3306,
  user: 'steve',
  password: 'steve',
  database: 'steve',
  connectionLimit: 5
});

export async function checkPg() {
  const res = await pg.query('select 1 as ok');
  return res.rows[0]?.ok === 1;
}

export async function checkMaria() {
  let conn;
  try {
    conn = await mdbPool.getConnection();
    const rows = await conn.query('select 1 as ok');
    return rows?.[0]?.ok === 1 || rows?.[0]?.['1'] === 1;
  } finally {
    if (conn) conn.release();
  }
}