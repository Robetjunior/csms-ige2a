// src/routes/events.ts
import { Router, Request, Response } from 'express';
import { insertEvento, upsertSessionStart, stopSession } from '../services/repo';

const router = Router();

/**
 * POST /v1/ocpp/events
 * Aceita eventos OCPP normalizados:
 *  {
 *    "type": "StartTransaction" | "StopTransaction" | "StatusNotification" | ...,
 *    "transactionId": 123,
 *    "chargeBoxId": "CB-01",
 *    "idTag": "ABC123",
 *    "reason": "Remote",
 *    "timestamp": "2025-08-14T15:00:00Z",
 *    "payload": { ... },
 *    "eventId": "opcional-para-idempotencia"
 *  }
 *
 * Campos mínimos: type (string). Se não vier "payload", o body inteiro é salvo como payload.
 */
router.post('/v1/ocpp/events', async (req: Request, res: Response) => {
  try {
    // 🔐 API Key opcional (apenas se ORCH_API_KEY estiver definida no ambiente)
    const expectedKey = process.env.ORCH_API_KEY;
    if (expectedKey) {
      const provided = (req.headers['x-api-key'] as string | undefined) || '';
      if (provided !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const b = req.body ?? {};
    const type = String(b.type || '').trim();
    if (!type) return res.status(400).json({ error: 'type is required' });

    const chargeBoxId = b.chargeBoxId ? String(b.changeBoxId ?? b.chargeBoxId) : null; // tolera "changeBoxId" por engano
    const transactionId = b.transactionId != null ? Number(b.transactionId) : null;
    const idTag = b.idTag ? String(b.idTag) : null;
    const reason = b.reason ? String(b.reason) : null;
    const timestamp = b.timestamp ? new Date(b.timestamp) : new Date();

    // Se vier payload, registra. Se não, salva o body inteiro.
    const payload = b.payload ?? b;

    // 👉 Insere evento (idempotente). A unique_key é gerada no repositório.
    const result = await insertEvento({
      tipo: type,
      payload,
      chargeBoxId,
      transactionId,
      idTag
    });

    // 🧠 Atualiza estado consolidado de sessão quando fizer sentido
    if (type === 'StartTransaction' && transactionId != null) {
      await upsertSessionStart({
        transactionId,
        chargeBoxId,
        idTag,
        startedAt: timestamp
      });
    } else if (type === 'StopTransaction' && transactionId != null) {
      await stopSession({
        transactionId,
        stoppedAt: timestamp,
        stopReason: reason
      });
    }

    // 202 quando novo; 200 quando duplicado (idempotente)
    return res.status(result.duplicate ? 200 : 202).json({
      accepted: true,
      idempotentDuplicate: result.duplicate
    });
  } catch (err: any) {
    console.error('[POST /v1/ocpp/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
