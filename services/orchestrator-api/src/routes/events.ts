import { Router, Request, Response } from 'express';
import { pg } from '../db'; 
import {
  insertEvento,
  upsertSessionStart,
  stopSession,
  listEvents,
  completeRemoteStopForTx,
} from '../services/repo';
import { OcppEventSchema } from '../validation/events';

const router = Router();

/**
 * GET /v1/events
 * Filtros: event_type, charge_box_id, connector_pk, transaction_pk, id_tag, from, to
 * Paginação: limit, offset
 * Ordenação: sort (created_at asc|desc)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const {
      event_type,
      charge_box_id,
      connector_pk,
      transaction_pk,
      id_tag,
      from,
      to,
      limit = '50',
      offset = '0',
      sort = 'desc',
    } = q;

    // parse seguro de datas
    const parseDate = (s?: string) => {
      if (!s) return undefined;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? 'invalid' as const : d;
    };
    const fromDate = parseDate(from);
    const toDate = parseDate(to);
    if (fromDate === 'invalid') {
      return res.status(400).json({
        error: 'invalid_from',
        hint: 'Use ISO 8601, ex: 2025-08-19T12:00:00Z',
      });
    }
    if (toDate === 'invalid') {
      return res.status(400).json({
        error: 'invalid_to',
        hint: 'Use ISO 8601, ex: 2025-08-19T23:59:59Z',
      });
    }

    const parsedLimit = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 500);
    const parsedOffset = Math.max(parseInt(String(offset), 10) || 0, 0);
    const parsedSort: 'asc' | 'desc' = (sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

    const result = await listEvents({
      eventType: event_type,
      chargeBoxId: charge_box_id,
      connectorPk: connector_pk ? Number(connector_pk) : undefined,
      transactionPk: transaction_pk ? Number(transaction_pk) : undefined,
      idTag: id_tag,
      from: typeof fromDate === 'object' ? fromDate : undefined,
      to: typeof toDate === 'object' ? toDate : undefined,
      limit: parsedLimit,
      offset: parsedOffset,
      sort: parsedSort,
    });

    return res.json(result);
  } catch (err) {
    console.error('[GET /v1/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/ocpp/events
 */
router.post('/events', async (req: Request, res: Response) => {
  try {
    const parsed = OcppEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_payload',
        details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const b = parsed.data;
    const rawChargeBoxId = (b as any).changeBoxId ?? b.chargeBoxId ?? null;

    const type = String(b.type).trim();
    const transactionId = b.transactionId != null ? Number(b.transactionId) : null;
    const chargeBoxId = rawChargeBoxId != null ? String(rawChargeBoxId) : null;
    const idTag = b.idTag != null ? String(b.idTag) : null;
    const reason = b.reason != null ? String(b.reason) : null;
    const timestamp = b.timestamp ? new Date(b.timestamp) : new Date();

    const payload = b.payload ?? (req.body ?? {});

    const result = await insertEvento({
      tipo: type,
      payload,
      chargeBoxId,
      transactionId,
      idTag,
    });

    if (type === 'StartTransaction' && transactionId != null) {
      await upsertSessionStart({
        transactionId,
        chargeBoxId,
        idTag,
        startedAt: timestamp,
      });
    } else if (type === 'StopTransaction' && transactionId != null) {
      await stopSession({
        transactionId,
        stoppedAt: timestamp,
        stopReason: reason,
      });
      // completa comando RemoteStop (se houver)
      await completeRemoteStopForTx({
        transactionId,
        response: payload,
      });
    }

    return res.status(result.duplicate ? 200 : 202).json({
      accepted: true,
      idempotentDuplicate: result.duplicate,
    });
  } catch (err) {
    console.error('[POST /v1/ocpp/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/events/:id
 * Retorna um evento específico pelo ID.  
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    const sql = `
      SELECT
        id,
        created_at,
        source,
        event_type,
        charge_box_id,
        (connector_pk)::int    AS connector_pk,
        (transaction_pk)::int  AS transaction_pk,
        id_tag,
        payload
      FROM public.events
      WHERE id = $1::bigint
      LIMIT 1
    `;
    const { rows } = await pg.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[GET /v1/events/:id] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
