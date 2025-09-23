import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { csms } from '../ocpp/csms';

const router = Router();

const ForceSchema = z.object({
  chargeBoxId: z.string().min(1),
  connectorId: z.number().int().nonnegative().default(0),
  doReset: z.boolean().default(true),
});

/** POST /v1/actions/force-available */
router.post('/force-available', async (req: Request, res: Response) => {
  const p = ForceSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error:'invalid_payload', details: p.error.issues });

  const { chargeBoxId, connectorId, doReset } = p.data;

  try {
    await csms.changeAvailability(chargeBoxId, { connectorId, type: 'Inoperative' });
    await csms.changeAvailability(chargeBoxId, { connectorId, type: 'Operative' });
    if (doReset) await csms.reset(chargeBoxId, 'Soft');

    return res.status(202).json({ ok: true, chargeBoxId, message: 'Disponibilidade forçada para Available (com Reset opcional).' });
  } catch (e: any) {
    return res.status(409).json({ ok: false, chargeBoxId, error: 'charge_point_offline', detail: e?.message || String(e) });
  }
});

export default router;
