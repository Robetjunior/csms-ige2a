import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';

const router = Router();

const StartSchema = z.object({
  transaction_id: z.number().int(),
  charge_box_id: z.string(),
  connector_id: z.number().int().optional(),
  id_tag: z.string().optional(),
  mode: z.enum(['AC','DC']).optional(),
  started_at: z.string().datetime().optional()
});

const RefreshSchema = z.object({
  transaction_id: z.number().int(),
  meterLatest: z.number().int().min(0),
});

const CloseSchema = z.object({
  transaction_id: z.number().int(),
  meterStart: z.number().int().min(0),
  meterStop: z.number().int().min(0),
  stopped_at: z.string().datetime().optional()
});

// POST /v1/billing/estimate
router.post('/estimate', async (req: Request, res: Response) => {
  const { charge_box_id, connector_id, mode='AC', expected_kwh=0, expected_minutes=0, active_at } = req.body || {};
  const at = active_at ? new Date(active_at) : new Date();

  const rt = await sb.rpc('resolve_tariff', {
    p_charge_box_id: charge_box_id ?? null,
    p_mode: String(mode).toUpperCase(),
    p_at: at.toISOString(),
  });
  if (rt.error) return res.status(500).json({ error: 'rpc_error', detail: rt.error.message });
  if (!rt.data?.length) return res.status(404).json({ error: 'tariff_not_found' });

  const t = rt.data[0];
  const kwh = Math.max(Number(expected_kwh||0),0);
  const minutes = Math.max(Number(expected_minutes||0),0);

  const energy_br = kwh * Number(t.price_kwh);
  const idle_billable = Math.max(0, minutes - Number(t.idle_grace_minutes));
  const idle_br = idle_billable * Number(t.idle_fee_per_minute);
  const total_br = Number(t.connection_fee) + energy_br + idle_br;

  return res.json({
    at: at.toISOString(),
    charge_box_id, connector_id, mode: String(mode).toUpperCase(),
    pricing: {
      tariff_id: t.id,
      price_kwh: Number(t.price_kwh),
      connection_fee: Number(t.connection_fee),
      idle_fee_per_minute: Number(t.idle_fee_per_minute),
      idle_grace_minutes: Number(t.idle_grace_minutes)
    },
    cost_breakdown: { energy_br, idle_minutes: idle_billable, idle_br, connection_br: Number(t.connection_fee), total_br }
  });
});

// POST /v1/billing/start
router.post('/start', async (req: Request, res: Response) => {
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const b = parsed.data;

  const started_at = b.started_at ? new Date(b.started_at) : new Date();
  const mode = (b.mode ?? 'AC').toUpperCase();

  const rt = await sb.rpc('resolve_tariff', {
    p_charge_box_id: b.charge_box_id,
    p_mode: mode,
    p_at: started_at.toISOString(),
  });
  if (rt.error) return res.status(500).json({ error: 'rpc_error', detail: rt.error.message });
  if (!rt.data?.length) return res.status(404).json({ error: 'tariff_not_found' });
  const t = rt.data[0];

  const snapshot = {
    tariff_id: t.id,
    mode,
    price_kwh: Number(t.price_kwh),
    connection_fee: Number(t.connection_fee),
    idle_fee_per_minute: Number(t.idle_fee_per_minute),
    idle_grace_minutes: Number(t.idle_grace_minutes),
  };

  const up = await sb
    .from('sessions')
    .upsert({
      transaction_id: b.transaction_id,
      charge_box_id: b.charge_box_id,
      id_tag: b.id_tag ?? null,
      connector_id: b.connector_id ?? null,
      mode,
      started_at: started_at.toISOString(),
      pricing_snapshot: snapshot,
    }, { onConflict: 'transaction_id' })
    .select('transaction_id')
    .single();

  if (up.error) return res.status(500).json({ error: 'upsert_error', detail: up.error.message });
  return res.status(201).json({ transaction_id: b.transaction_id, pricing_snapshot: snapshot });
});

// POST /v1/billing/refresh
router.post('/refresh', async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const b = parsed.data;

  const startEv = await sb
    .from('ocpp_events')
    .select('payload')
    .eq('tipo','StartTransaction')
    .eq('transaction_id', b.transaction_id)
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (startEv.error) return res.status(500).json({ error: 'query_error', detail: startEv.error.message });
  const meterStart = startEv.data ? Number((startEv.data as any).payload?.meterStart ?? 0) : 0;

  const kwh = Math.max(0, (b.meterLatest - meterStart) / 1000.0);

  const sess = await sb
    .from('sessions')
    .select('pricing_snapshot, started_at')
    .eq('transaction_id', b.transaction_id)
    .limit(1)
    .maybeSingle();

  if (sess.error) return res.status(500).json({ error: 'query_error', detail: sess.error.message });
  if (!sess.data) return res.status(404).json({ error: 'session_not_found' });

  const snap = (sess.data as any).pricing_snapshot || {};
  const duration_seconds = Math.floor((Date.now() - new Date((sess.data as any).started_at).getTime())/1000);

  const energy_br = kwh * Number(snap.price_kwh ?? 0);
  const idle_minutes = 0;
  const idle_br = 0;
  const total_br = Number(snap.connection_fee ?? 0) + energy_br + idle_br;

  return res.json({
    transaction_id: b.transaction_id,
    energy_kwh_so_far: kwh,
    duration_seconds,
    pricing: snap,
    cost_breakdown: { energy_br, idle_minutes, idle_br, connection_br: Number(snap.connection_fee ?? 0), total_br }
  });
});

// POST /v1/billing/close
router.post('/close', async (req: Request, res: Response) => {
  const parsed = CloseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const b = parsed.data;

  const s = await sb
    .from('sessions')
    .select('id, started_at, pricing_snapshot, charge_box_id, id_tag')
    .eq('transaction_id', b.transaction_id)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (s.error) return res.status(500).json({ error: 'query_error', detail: s.error.message });
  if (!s.data) return res.status(404).json({ error: 'session_not_found' });

  const stopped_at = b.stopped_at ? new Date(b.stopped_at) : new Date();
  const duration_seconds = Math.max(0, Math.floor((stopped_at.getTime() - new Date((s.data as any).started_at).getTime())/1000));
  const kwh = Math.max(0, (b.meterStop - b.meterStart) / 1000.0);

  const snap = (s.data as any).pricing_snapshot || {};
  const energy_br = kwh * Number(snap.price_kwh ?? 0);
  const idle_minutes = 0;
  const idle_br = 0;
  const total_br = Number(snap.connection_fee ?? 0) + energy_br + idle_br;

  const upd = await sb
    .from('sessions')
    .update({ stopped_at: stopped_at.toISOString(), stop_reason: 'Remote', energy_kwh: kwh, revenue_br: total_br })
    .eq('id', (s.data as any).id);
  if (upd.error) return res.status(500).json({ error: 'update_error', detail: upd.error.message });

  const inv = await sb
    .from('invoices')
    .upsert({
      session_fk: (s.data as any).id,
      transaction_id: b.transaction_id,
      charge_box_id: (s.data as any).charge_box_id,
      id_tag: (s.data as any).id_tag,
      started_at: (s.data as any).started_at,
      stopped_at: stopped_at.toISOString(),
      energy_kwh: kwh,
      idle_minutes,
      total_br,
      breakdown: { connection_br: Number(snap.connection_fee ?? 0), energy_br, idle_br, price_kwh: Number(snap.price_kwh ?? 0) }
    }, { onConflict: 'session_fk' })
    .select('id')
    .single();

  if (inv.error) return res.status(500).json({ error: 'upsert_invoice_error', detail: inv.error.message });

  return res.json({
    transaction_id: b.transaction_id,
    invoice_id: inv.data.id,
    totals: { energy_kwh: kwh, duration_seconds, total_br },
  });
});

// GET /v1/billing/invoices
router.get('/invoices', async (req: Request, res: Response) => {
  try {
    const pickFirst = <T,>(v: T | T[] | undefined | null): T | undefined => Array.isArray(v) ? v[0] : (v ?? undefined);
    const parseISOorUnix = (v: unknown): Date | null => {
      const raw = pickFirst(v);
      if (raw == null) return null;
      if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw);
      if (typeof raw === 'string') {
        const s = raw.trim(); if (!s) return null;
        if (/^\d{10,}$/.test(s)) { const d = new Date(Number(s)); return Number.isFinite(d.getTime()) ? d : null; }
        const d = new Date(s); return Number.isFinite(d.getTime()) ? d : null;
      }
      return null;
    };
    const asTrimmedOrNull = (v: unknown): string | null => {
      const raw = pickFirst(v);
      if (typeof raw !== 'string') return null;
      const t = raw.trim(); return t.length ? t : null;
    };
    const asInt = (v: unknown, def = 100): number => {
      const raw = pickFirst(v);
      if (typeof raw === 'string' && raw.trim() !== '') { const n = parseInt(raw,10); if (Number.isFinite(n)) return n; }
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      return def;
    };

    const fromQ = parseISOorUnix(req.query.from);
    const toQ   = parseISOorUnix(req.query.to);
    const from  = fromQ ?? new Date(Date.now() - 30*24*60*60*1000);
    const to    = toQ   ?? new Date();

    if ((pickFirst(req.query.from) !== undefined && !fromQ) ||
        (pickFirst(req.query.to)   !== undefined && !toQ)) {
      return res.status(400).json({ error: 'invalid_query', details: 'from/to must be ISO-8601 or UNIX ms' });
    }

    const cb    = asTrimmedOrNull(req.query.charge_box_id);
    const idTag = asTrimmedOrNull(req.query.id_tag);
    const limit = Math.min(Math.max(asInt(req.query.limit, 100), 1), 1000);

    let q = sb
      .from('invoices')
      .select('id, session_fk, transaction_id, charge_box_id, id_tag, started_at, stopped_at, energy_kwh, idle_minutes, total_br, breakdown')
      .gte('started_at', from.toISOString())
      .lt('started_at', to.toISOString())
      .order('started_at', { ascending: false })
      .limit(limit);

    if (cb) q = q.eq('charge_box_id', cb);
    if (idTag) q = q.eq('id_tag', idTag);

    const r = await q;
    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });

    return res.json({ items: r.data });
  } catch (err) {
    console.error('[GET /v1/billing/invoices] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v1/billing/invoices/:id
router.get('/invoices/:id', async (req, res) => {
  try {
    const id = Number(String(req.params.id ?? '').trim());
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

    const r = await sb
      .from('invoices')
      .select('id, session_fk, transaction_id, charge_box_id, id_tag, started_at, stopped_at, energy_kwh, idle_minutes, total_br, breakdown')
      .eq('id', id)
      .single();

    if (r.error?.code === 'PGRST116') return res.status(404).json({ error: 'not_found' });
    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });

    return res.json(r.data);
  } catch (err) {
    console.error('[GET /v1/billing/invoices/:id] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
