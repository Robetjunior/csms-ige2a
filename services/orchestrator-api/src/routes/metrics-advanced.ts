// src/routes/metrics-advanced.ts
import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';

const router = Router();

const norm = (s?: string) => (s ?? '').trim() || undefined;
const parseDateISO = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/**
 * GET /v1/metrics/utilization?from&to&charge_box_id
 */
router.get('/utilization', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 7*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();
    const cbId = norm(String(req.query.charge_box_id)) ?? null;

    const r = await sb.rpc('metrics_utilization', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_charge_box_id: cbId,
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items: r.data || [] });
  } catch (err) {
    console.error('[utilization] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/reliability?from&to
 */
router.get('/reliability', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const r = await sb.rpc('metrics_reliability', { p_from: from.toISOString(), p_to: to.toISOString() }).single();
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, ...r.data });
  } catch (err) {
    console.error('[reliability] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/funnel?from&to
 */
router.get('/funnel', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const r = await sb.rpc('metrics_funnel', { p_from: from.toISOString(), p_to: to.toISOString() }).single();
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, ...r.data });
  } catch (err) {
    console.error('[funnel] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/arpu?from&to
 */
router.get('/arpu', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const r = await sb.rpc('metrics_arpu', { p_from: from.toISOString(), p_to: to.toISOString() }).single();
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, ...r.data });
  } catch (err) {
    console.error('[arpu] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/cohorts/monthly?year=2025
 */
router.get('/cohorts/monthly', async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.query.year || new Date().getUTCFullYear()), 10);
    const r = await sb.rpc('metrics_cohorts_monthly', { p_year: year });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ year, months: r.data || [] });
  } catch (err) {
    console.error('[cohorts/monthly] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/anomalies?from&to
 */
router.get('/anomalies', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const r = await sb.rpc('metrics_anomalies', { p_from: from.toISOString(), p_to: to.toISOString() });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items: r.data || [] });
  } catch (err) {
    console.error('[anomalies] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/forecast/revenue?months=3
 */
router.get('/forecast/revenue', async (req: Request, res: Response) => {
  try {
    const months = Math.min(Math.max(parseInt(String(req.query.months || '3'),10) || 3, 1), 12);

    const r = await sb.rpc('metrics_forecast_revenue', { p_months: months }).single();
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ months_window: months, projection: Number(r.data?.next_month_revenue_br ?? 0) });
  } catch (err) {
    console.error('[forecast/revenue] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/live  (SSE)
 */
router.get('/live', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const tick = async () => {
    try {
      const r = await sb.rpc('metrics_live').single();
      if (r.error) {
        res.write(`event: error\ndata: ${JSON.stringify(r.error.message)}\n\n`);
        return;
      }
      res.write(`data: ${JSON.stringify(r.data)}\n\n`);
    } catch (err) {
      console.error('[live] error:', err);
      res.write(`event: error\ndata: "internal_error"\n\n`);
    }
  };

  const iv = setInterval(tick, 5000);
  tick();
  _req.on('close', () => clearInterval(iv));
});

export default router;
