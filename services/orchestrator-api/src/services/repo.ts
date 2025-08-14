// src/services/repo.ts
import { pg } from '../db';

type InsertEventoArgs = {
  tipo: string;
  payload: any;
  chargeBoxId: string | null;
  transactionId: number | null;
  idTag: string | null;
  uniqueKey?: string; // opcional
};

/**
 * Insere evento com idempotência via unique_key.
 * - Se payload tiver eventId/id, usa como unique_key; senão deriva de (type, tx, cb, timestamp arredondado).
 * - Retorna duplicate=true quando a unique_key já existia.
 */
export async function insertEvento(args: InsertEventoArgs): Promise<{ duplicate: boolean }> {
  const { tipo, payload, chargeBoxId, transactionId, idTag, uniqueKey: providedKey } = args;

  const eventId = payload?.eventId ?? payload?.id ?? null;
  const roundedTs = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

  const uniqueKey =
    providedKey ||
    (eventId
      ? `id:${String(eventId)}`
      : `t:${tipo}|tx:${transactionId ?? '-'}|cb:${chargeBoxId ?? '-'}|ts:${roundedTs}`);

  const sql = `
    INSERT INTO public.eventos (tipo, payload, charge_box_id, transaction_id, id_tag, unique_key)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (unique_key) DO NOTHING
    RETURNING id;
  `;
  const params = [tipo, JSON.stringify(payload), chargeBoxId, transactionId, idTag, uniqueKey];

  const r = await pg.query<{ id: number }>(sql, params);
  const inserted = !!r.rowCount && r.rowCount > 0;
  return { duplicate: !inserted };
}

/**
 * Abre/atualiza sessão consolidada no início da transação.
 */
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

/**
 * Finaliza sessão consolidada no fim da transação.
 */
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
