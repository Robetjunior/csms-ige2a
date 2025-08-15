// src/services/repo.ts
import { pg } from '../db';

type InsertEventoArgs = {
  tipo: string;
  payload: any;
  chargeBoxId: string | null;
  transactionId: number | null;
  idTag: string | null;
  uniqueKey?: string;
};

/**
 * Regras de idempotência:
 *  1) Se houver eventId (ou id) no payload -> unique_key = "id:<eventId>"
 *  2) Se for StartTransaction/StopTransaction e tiver transactionId -> unique_key = "t:<tipo>|tx:<tx>|cb:<cb>"
 *  3) Caso contrário -> unique_key com timestamp arredondado ao segundo
 */
export async function insertEvento(args: InsertEventoArgs): Promise<{ duplicate: boolean }> {
  const { tipo, payload, chargeBoxId, idTag, uniqueKey: providedKey } = args;

  // sanitize transactionId
  const txIdRaw = args.transactionId;
  const txId: number | null =
    typeof txIdRaw === 'number' && Number.isFinite(txIdRaw) ? txIdRaw : null;

  const isStartOrStop = (tipo === 'StartTransaction' || tipo === 'StopTransaction');
  const eventId = payload?.eventId ?? payload?.id ?? null;

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
    console.log('[repo.insertEvento] tipo=%s tx=%s cb=%s -> unique_key=%s',
      tipo, String(txId ?? '-'), String(chargeBoxId ?? '-'), uniqueKey);
  }

  const sql = `
    INSERT INTO public.eventos (tipo, payload, charge_box_id, transaction_id, id_tag, unique_key)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (unique_key) DO NOTHING
    RETURNING id;
  `;
  const params = [tipo, JSON.stringify(payload), chargeBoxId, txId, idTag, uniqueKey];

  const r = await pg.query<{ id: number }>(sql, params);
  const inserted = (r.rowCount ?? 0) > 0;
  return { duplicate: !inserted };
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
