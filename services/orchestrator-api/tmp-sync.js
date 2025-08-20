const { Client } = require('pg');
const mysql = require('mysql2/promise');

const CHARGEBOX = process.env.CHARGEBOX || null;
const FROM = process.env.FROM || '2025-08-20T00:00:00Z';
const TO   = process.env.TO   || '2025-08-21T00:00:00Z';

(async () => {
  const pg = new Client({ connectionString: process.env.POSTGRES_URI });
  await pg.connect();

  const mdb = await mysql.createConnection({
    host: process.env.MARIADB_HOST || 'mariadb',
    port: Number(process.env.MARIADB_PORT || 3306),
    user: process.env.MARIADB_USER || 'steve',
    password: process.env.MARIADB_PASSWORD || 'steve',
    database: process.env.MARIADB_DATABASE || 'steve'
  });

  // parâmetros MariaDB (sem 'Z'/'T')
  const params = [
    FROM.replace('Z',' ').replace('T',' '),
    TO.replace('Z',' ').replace('T',' ')
  ];
  const whereCb = CHARGEBOX ? ' AND c.charge_box_id = ?' : '';
  if (CHARGEBOX) params.push(CHARGEBOX);

  // SELECT limpo (usando a view tx já criada)
  const sql =
    'SELECT ' +
    '  t.transaction_pk AS transaction_id, ' +
    '  c.charge_box_id, ' +
    '  t.id_tag, ' +
    '  t.start_timestamp AS started_at, ' +
    '  t.stop_timestamp  AS stopped_at, ' +
    '  t.stop_reason ' +
    'FROM tx t ' +
    'JOIN connector c ON c.connector_pk = t.connector_pk ' +
    'WHERE t.start_timestamp >= ? AND t.start_timestamp < ?' +
    whereCb + ' ' +
    'ORDER BY t.transaction_pk ASC';

  const [rows] = await mdb.execute(sql, params);

  // UPSERT com ON CONFLICT (chave: transaction_id)
  const upsertSql =
    'INSERT INTO orchestrator.sessions ' +
    '(transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason) ' +
    'VALUES (' + '$' + '1::bigint, ' + '$' + '2::text, ' + '$' + '3::text, ' + '$' + '4::timestamptz, ' + '$' + '5::timestamptz, ' + '$' + '6::text) ' +
    'ON CONFLICT (transaction_id) DO UPDATE SET ' +
    '  charge_box_id = EXCLUDED.charge_box_id, ' +
    '  id_tag        = EXCLUDED.id_tag, ' +
    '  started_at    = EXCLUDED.started_at, ' +
    '  stopped_at    = EXCLUDED.stopped_at, ' +
    '  stop_reason   = EXCLUDED.stop_reason';

  let upserts = 0;
  await pg.query('BEGIN');
  try {
    for (const r of rows) {
      await pg.query(upsertSql, [
        r.transaction_id,
        r.charge_box_id || null,
        r.id_tag || null,
        r.started_at ? new Date(r.started_at) : null,
        r.stopped_at ? new Date(r.stopped_at) : null,
        r.stop_reason || null
      ]);
      upserts++;
    }
    await pg.query('COMMIT');
  } catch (e) {
    await pg.query('ROLLBACK');
    throw e;
  }

  console.log('Upserts:', upserts);
  await mdb.end(); await pg.end();
})().catch(e => { console.error(e); process.exit(1); });
