// src/routes/events.ts
import { Router, Request, Response } from 'express';
import { insertEvento } from '../services/repo';

const router = Router();

/**
 * POST /v1/ocpp/events
 * Aceita eventos OCPP normalizados:
 *  { "type":"StartTransaction","transactionId":123,"chargeBoxId":"CB-01","idTag":"ABC123","timestamp":"2025-08-14T15:00:00Z","payload":{...} }
 * Campos mínimos aceitos: type (string), payload (obj/opcional)
 */
router.post('/v1/ocpp/events', async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const type = String(b.type || '').trim();
    if (!type) return res.status(400).json({ error: 'type is required' });

    const chargeBoxId = b.chargeBoxId ? String(b.chargeBoxId) : null;
    const transactionId = b.transactionId != null ? Number(b.transactionId) : null;
    const idTag = b.idTag ? String(b.idTag) : null;

    // Se vier payload, registra. Se não vier, registra o body inteiro.
    const payload = b.payload ?? b;

    await insertEvento({
      tipo: type,
      payload,
      chargeBoxId,
      transactionId,
      idTag
    });

    // 202: aceito para processamento (sem bloquear o caller)
    return res.status(202).json({ accepted: true });
  } catch (err: any) {
    console.error('[POST /v1/ocpp/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
