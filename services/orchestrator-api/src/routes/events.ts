import { Router, Request, Response } from 'express';
import { insertEvento, upsertSessionStart, stopSession, listEvents, completeRemoteStopForTx } from '../services/repo';
import { OcppEventSchema } from '../validation/events';

const router = Router();

/**
 * GET /v1/events
 * Filtros: event_type, charge_box_id, connector_pk, transaction_pk, id_tag, from, to
 * Paginação: limit, offset
 * Ordenação: sort (created_at asc|desc)
 */
router.get('/events', async (req: Request, res: Response) => {
  try {
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
    } = req.query as Record<string, string | undefined>;

    const result = await listEvents({
      eventType: event_type,
      chargeBoxId: charge_box_id,
      connectorPk: connector_pk ? Number(connector_pk) : undefined,
      transactionPk: transaction_pk ? Number(transaction_pk) : undefined,
      idTag: id_tag,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Math.min(Math.max(parseInt(String(limit) || '50', 10), 1), 500),
      offset: Math.max(parseInt(String(offset) || '0', 10), 0),
      sort: (sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    });

    return res.json(result);
  } catch (err: any) {
    console.error('[GET /v1/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /v1/ocpp/events
 */
router.post('/ocpp/events', async (req: Request, res: Response) => {
  try {
    const expectedKey = process.env.ORCH_API_KEY;
    if (expectedKey) {
      const provided = (req.headers['x-api-key'] as string | undefined) || '';
      if (provided !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

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

      // anexa o payload bruto para auditoria e completa o comando:
      await completeRemoteStopForTx({
        transactionId,
        response: payload, 
      });
    }

    return res.status(result.duplicate ? 200 : 202).json({
      accepted: true,
      idempotentDuplicate: result.duplicate,
    });
  } catch (err: any) {
    console.error('[POST /v1/ocpp/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;