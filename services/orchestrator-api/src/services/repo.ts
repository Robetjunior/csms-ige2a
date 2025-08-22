// src/services/repo.ts
import { pg } from '../db';

type InsertEventoArgs = {
  tipo: string;
  payload: any;
  chargeBoxId: string | null;
  transactionId: number | null;
  idTag: string | null;
  uniqueKey?: string; // mantido apenas para log/rastreamento
};

export async function insertEvento(args: InsertEventoArgs): Promise<{ duplicate: boolean }> {
  const { tipo, payload, chargeBoxId, idTag, uniqueKey: providedKey } = args;

  const txIdRaw = args.transactionId;
  const txId: number | null =
    typeof txIdRaw === 'number' && Number.isFinite(txIdRaw) ? txIdRaw : null;

  const isStartOrStop = (tipo === 'StartTransaction' || tipo === 'StopTransaction');
  const eventId = payload?.eventId ?? payload?.id ?? null;

  // Timestamp apenas para compor uma chave “natural” de log (não persiste)
  const tsBase = payload?.timestamp ? new Date(payload.timestamp) : new Date();
  const roundedTs = new Date(Math.floor(tsBase.getTime() / 1000) * 1000).toISOString();

  let uniqueKey: string;
  if (providedKey) {
    uniqueKey = providedKey;
  } else if (isStartOrStop && txId !== null) {
    uniqueKey = `t:${tipo}|tx:${txId}|cb:${chargeBoxId ?? '-'}`;
  } else if (eventId != null) {
    uniqueKey = `id:${String(eventId)}`;
  } else {
    uniqueKey = `t:${tipo}|tx:${txId ?? '-'}|cb:${chargeBoxId ?? '-'}|ts:${roundedTs}`;
  }

  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    console.log('[repo.insertEvento] tipo=%s tx=%s cb=%s -> unique_key(log)=%s',
      tipo, String(txId ?? '-'), String(chargeBoxId ?? '-'), uniqueKey);
  }

  // Inserimos diretamente na tabela base do orchestrator
  const sql = `
    INSERT INTO orchestrator.ocpp_events (tipo, payload, charge_box_id, transaction_id, id_tag, created_at)
    VALUES ($1, $2::jsonb, $3, $4, $5, now())
    RETURNING id;
  `;
  const params = [
    tipo,                    // $1
    JSON.stringify(payload), // $2
    chargeBoxId,             // $3
    txId,                    // $4
    idTag,                   // $5
  ];

  const r = await pg.query<{ id: number }>(sql, params);
  const inserted = (r.rowCount ?? 0) > 0;

  if (inserted) {
    console.log(`[ingest] inserted id=${r.rows[0]?.id ?? '-'} key(log)=${uniqueKey}`);
  } else {
    console.warn(`[ingest] insert returned 0 rows (unexpected) key(log)=${uniqueKey}`);
  }

  // Sem índice único no banco, não dá para afirmar duplicidade pelo retorno do INSERT.
  return { duplicate: false };
}

export async function upsertSessionStart(args: {
  transactionId: number;
  chargeBoxId?: string | null;
  idTag?: string | null;
  startedAt?: Date;
}) {
  const { transactionId, chargeBoxId, idTag, startedAt } = args;
  const sql = `
    INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, started_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (transaction_id)
    DO UPDATE SET
      charge_box_id = EXCLUDED.charge_box_id,
      id_tag        = COALESCE(EXCLUDED.id_tag, orchestrator.sessions.id_tag),
      started_at    = COALESCE(orchestrator.sessions.started_at, EXCLUDED.started_at);
  `;
  await pg.query(sql, [
    transactionId,
    chargeBoxId ?? null,
    idTag ?? null,
    (startedAt ?? new Date()).toISOString(),
  ]);
}

export async function listSessions(args: {
  chargeBoxId?: string;
  idTag?: string;
  transactionId?: number;
  status?: 'active'|'completed';
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
  sort: 'asc'|'desc';
}) {
  const where: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (args.chargeBoxId) { where.push(`s.charge_box_id = $${i++}`); params.push(args.chargeBoxId); }
  if (args.idTag)       { where.push(`s.id_tag = $${i++}`);       params.push(args.idTag); }
  if (args.transactionId != null) { where.push(`s.transaction_id = $${i++}::int`); params.push(args.transactionId); }
  if (args.from) { where.push(`s.started_at >= $${i++}`); params.push(args.from.toISOString()); }
  if (args.to)   { where.push(`s.started_at <= $${i++}`); params.push(args.to.toISOString()); }
  if (args.status === 'active') where.push(`s.stopped_at IS NULL`);
  if (args.status === 'completed') where.push(`s.stopped_at IS NOT NULL`);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      (s.transaction_id)::int AS transaction_id,
      s.charge_box_id,
      s.id_tag,
      s.started_at,
      s.stopped_at,
      s.stop_reason,
      CASE WHEN s.stopped_at IS NULL THEN 'active' ELSE 'completed' END AS status,
      EXTRACT(EPOCH FROM (COALESCE(s.stopped_at, now()) - s.started_at))::int AS duration_seconds
    FROM orchestrator.sessions s
    ${whereSql}
    ORDER BY s.started_at ${args.sort}
    LIMIT $${i++}
    OFFSET $${i++}
  `;

  const { rows } = await pg.query(sql, [...params, args.limit, args.offset]);
  return { count: rows.length, items: rows };
}

export async function completeRemoteStopForTx(args: {
  transactionId: number;
  response?: any; 
}) {
  const { transactionId, response } = args;

  // 1) busca o último comando "aberto" e trava a linha
  const findSql = `
    SELECT id
      FROM orchestrator.commands
     WHERE command_type = 'RemoteStop'
       AND transaction_id = $1::int
       AND status IN ('pending','sent','accepted')
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  `;
  const client = await pg.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ id: number }>(findSql, [transactionId]);
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return { updated: false as const, reason: 'no_open_command' };
    }

    const cmdId = found.rows[0].id;

    const updSql = `
      UPDATE orchestrator.commands
         SET status     = 'completed',
             response   = COALESCE($2::jsonb, '{}'::jsonb),
             updated_at = now()
       WHERE id = $1::bigint
    `;
    await client.query(updSql, [cmdId, JSON.stringify(response ?? {})]);

    await client.query('COMMIT');
    return { updated: true as const, commandId: cmdId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function stopSession(args: {
  transactionId: number;
  stoppedAt?: Date;
  stopReason?: string | null;
}) {
  const { transactionId, stoppedAt, stopReason } = args;
  const sql = `
    UPDATE orchestrator.sessions
       SET stopped_at = COALESCE($2, stopped_at),
           stop_reason = COALESCE($3, stop_reason)
     WHERE transaction_id = $1;
  `;
  await pg.query(sql, [
    transactionId,
    (stoppedAt ?? new Date()).toISOString(),
    stopReason ?? null,
  ]);
}

// ===== Listagem de eventos (GET /v1/events) =====
export async function listEvents(args: {
  eventType?: string;
  chargeBoxId?: string;
  connectorPk?: number;
  transactionPk?: number;
  idTag?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
  sort: 'asc' | 'desc';
}) {
  const {
    eventType, chargeBoxId, connectorPk, transactionPk, idTag, from, to, limit, offset, sort,
  } = args;

  const where: string[] = [];
  const params: any[] = [];
  let i = 1;

  if (eventType)      { where.push(`event_type   = $${i++}`); params.push(eventType); }
  if (chargeBoxId)    { where.push(`charge_box_id = $${i++}`); params.push(chargeBoxId); }
  if (connectorPk != null)   { where.push(`connector_pk   = $${i++}`); params.push(connectorPk); }
  if (transactionPk != null) { where.push(`transaction_pk = $${i++}`); params.push(transactionPk); }
  if (idTag)          { where.push(`id_tag        = $${i++}`); params.push(idTag); }
  if (from)           { where.push(`created_at   >= $${i++}`); params.push(from.toISOString()); }
  if (to)             { where.push(`created_at   <= $${i++}`); params.push(to.toISOString()); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      id,
      created_at,
      source,
      event_type,
      charge_box_id,
      connector_pk,
      transaction_pk,
      id_tag,
      payload,
      COUNT(*) OVER() AS _total
    FROM orchestrator.events
    ${whereSql}
    ORDER BY created_at ${sort}
    LIMIT $${i++}
    OFFSET $${i++}
  `;
  params.push(limit, offset);

  // Logs de sanidade (dev)
  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    console.log('[listEvents] whereSql=%s params=%o', whereSql, params);
  }

  console.log('[listEvents] whereSql=%s params=%o', whereSql, params);
  try {
    const { rows } = await pg.query(sql, params);
    const total = rows.length ? Number(rows[0]._total) : 0;
    const items = rows.map(({ _total, ...r }) => r);
    if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      console.log('[listEvents] rows=%d', rows.length);
    }
    return { count: total, items };
  } catch (e: any) {
    console.error('[listEvents] QUERY FAILED:', {
      message: e?.message,
      detail: e?.detail,
      hint: e?.hint,
      position: e?.position,
      whereSql,
      params,
    });
    throw e;
  }
}
