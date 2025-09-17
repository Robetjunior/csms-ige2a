import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';

const router = Router();

const TariffCreate = z.object({
  scope: z.object({
    type: z.enum(['global','charge_box']).default('global'),
    charge_box_id: z.string().min(1).optional(),
  }),
  valid_from: z.string().datetime(),
  valid_to: z.string().datetime().optional().nullable(),
  applies_mode: z.enum(['AC','DC','ANY']).default('ANY'),
  price_ac_kwh: z.number().positive(),
  price_dc_kwh: z.number().positive(),
  connection_fee: z.number().min(0).default(0),
  idle_fee_per_minute: z.number().min(0).default(0),
  idle_grace_minutes: z.number().min(0).default(0),
});

// POST /v1/tariffs
router.post('/', async (req: Request, res: Response) => {
  const parsed = TariffCreate.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  }
  const b = parsed.data;

  const ins = await sb
    .from('tariffs')
    .insert({
      scope_type: b.scope.type,
      charge_box_id: b.scope.charge_box_id ?? null,
      applies_mode: b.applies_mode,
      valid_from: b.valid_from ?? new Date().toISOString(),
      valid_to: b.valid_to ?? null,
      price_ac_kwh: b.price_ac_kwh,
      price_dc_kwh: b.price_dc_kwh,
      connection_fee: b.connection_fee,
      idle_fee_per_minute: b.idle_fee_per_minute,
      idle_grace_minutes: b.idle_grace_minutes
    })
    .select('*')
    .single();

  if (ins.error) return res.status(500).json({ error: 'insert_error', detail: ins.error.message });
  return res.status(201).json(ins.data);
});

// GET /v1/tariffs
router.get('/', async (req: Request, res: Response) => {
  const at = req.query.active_at ? new Date(String(req.query.active_at)) : new Date();
  const cb = (req.query.charge_box_id as string|undefined)?.trim() || null;
  const mode = (req.query.mode as string|undefined)?.toUpperCase() || 'AC';

  const rt = await sb.rpc('resolve_tariff', {
    p_charge_box_id: cb,
    p_mode: mode,
    p_at: at.toISOString(),
  });
  if (rt.error) return res.status(500).json({ error: 'rpc_error', detail: rt.error.message });
  if (!rt.data?.length) return res.status(404).json({ error: 'tariff_not_found' });

  return res.json({
    at: at.toISOString(),
    charge_box_id: cb,
    mode,
    resolved: rt.data[0]
  });
});

// POST /v1/tariffs/preview
router.post('/preview', async (req: Request, res: Response) => {
  const q = req.body as any;
  const at = q.active_at ? new Date(q.active_at) : new Date();
  const cb = (q.charge_box_id ?? null) as string|null;
  const mode = String(q.mode ?? 'AC').toUpperCase();
  const kwh = Math.max(Number(q.expected_kwh ?? 0), 0);
  const minutes = Math.max(Number(q.expected_minutes ?? 0), 0);

  const rt = await sb.rpc('resolve_tariff', {
    p_charge_box_id: cb,
    p_mode: mode,
    p_at: at.toISOString(),
  });
  if (rt.error) return res.status(500).json({ error: 'rpc_error', detail: rt.error.message });
  if (!rt.data?.length) return res.status(404).json({ error: 'tariff_not_found' });

  const t = rt.data[0];
  const energy_br = kwh * Number(t.price_kwh);
  const idle_billable = Math.max(0, minutes - Number(t.idle_grace_minutes));
  const idle_br = idle_billable * Number(t.idle_fee_per_minute);
  const total_br = Number(t.connection_fee) + energy_br + idle_br;

  return res.json({
    at: at.toISOString(),
    charge_box_id: cb, mode,
    pricing: {
      tariff_id: t.id,
      price_kwh: Number(t.price_kwh),
      connection_fee: Number(t.connection_fee),
      idle_fee_per_minute: Number(t.idle_fee_per_minute),
      idle_grace_minutes: Number(t.idle_grace_minutes)
    },
    estimate_input: { expected_kwh: kwh, expected_minutes: minutes },
    cost_breakdown: { energy_br, idle_minutes: idle_billable, idle_br, connection_br: Number(t.connection_fee), total_br }
  });
});

export default router;
