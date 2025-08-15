import { Router, Request, Response } from 'express';
import { insertEvento, upsertSessionStart, stopSession } from '../services/repo';
import { OcppEventSchema } from '../validation/events';

const router = Router();

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

    // ✅ Validação com Zod (mensagens claras se algo vier inválido)
    const parsed = OcppEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_payload',
        details: parsed.error.issues.map(i => ({ path: i.path, message: i.message }))
      });
    }

    const b = parsed.data;

    // Pequena tolerância para quem errar o nome de chargeBoxId como "changeBoxId"
    const rawChargeBoxId = (b as any).changeBoxId ?? b.chargeBoxId ?? null;

    const type = String(b.type).trim();
    const transactionId = b.transactionId != null ? Number(b.transactionId) : null;
    const chargeBoxId = rawChargeBoxId != null ? String(rawChargeBoxId) : null;
    const idTag = b.idTag != null ? String(b.idTag) : null;
    const reason = b.reason != null ? String(b.reason) : null;
    const timestamp = b.timestamp ? new Date(b.timestamp) : new Date();

    // Se vier payload, registra; se não vier, salva o body inteiro
    const payload = b.payload ?? (req.body ?? {});

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
