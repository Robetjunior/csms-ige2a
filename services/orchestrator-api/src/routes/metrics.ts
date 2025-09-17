import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';

const router = Router();

const norm = (s?: string) => (s ?? '').trim() || undefined;
const parseDateISO = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

// ========= OVERVIEW =========
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const cbId = norm(q.charge_box_id) ?? null;

    // 🔵 Opção A (recomendada): RPC 'metrics_overview(from,to,cb_id)'
    const rpc = await sb.rpc('metrics_overview', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_charge_box_id: cbId
    }).maybeSingle();

    if (!rpc.error && rpc.data) {
      const r: any = rpc.data;
      return res.json({
        period: { from: from.toISOString(), to: to.toISOString() },
        totals: {
          events: Number(r.events || 0),
          sessions: Number(r.sessions || 0),
          active_sessions: Number(r.active_sessions || 0),
          unique_charge_boxes: Number(r.unique_charge_boxes || 0),
          energy_kwh: Number(r.energy_kwh || 0),
          revenue_br: Number(r.revenue_br || 0),
          avg_session_minutes: Number(r.avg_session_minutes || 0),
        },
        health: { ready: true, supabase: 'up' }
      });
    }

    // 🟠 Opção B (fallback simples em JS)
    const ev = await sb
      .from('events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', from.toISOString())
      .lt('created_at', to.toISOString());
    const base = await sb
      .from('session_financials')
      .select('charge_box_id, status, duration_seconds, energy_kwh, revenue_br')
      .gte('started_at', from.toISOString())
      .lt('started_at', to.toISOString())
      .maybeSingle(); // OBS: para dados grandes, troque por RPC!
    const rows = (base.data ? [base.data] : []) as any[];

    const sessions = rows.length;
    const active_sessions = rows.filter(r => r.status === 'active').length;
    const unique_charge_boxes = new Set(rows.map(r => r.charge_box_id)).size;
    const energy_kwh = rows.reduce((a,r)=>a+Number(r.energy_kwh||0),0);
    const revenue_br = rows.reduce((a,r)=>a+Number(r.revenue_br||0),0);
    const avg_session_minutes = Math.trunc(rows.reduce((a,r)=>a+Number(r.duration_seconds||0),0) / Math.max(sessions,1) / 60);

    return res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        events: ev.count ?? 0,
        sessions, active_sessions, unique_charge_boxes,
        energy_kwh, revenue_br, avg_session_minutes
      },
      health: { ready: true, supabase: 'up' }
    });
  } catch (err) {
    console.error('[GET /v1/metrics/overview] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ========= CHARGING MIX =========
router.get('/charging-mix', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30*24*60*60*1000);
    const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();

    const r = await sb.rpc('metrics_charging_mix', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      items: (r.data || []).map((x: any) => ({
        mode: x.mode,
        sessions: Number(x.sessions),
        energy_kwh: Number(x.energy_kwh),
        revenue_br: Number(x.revenue_br)
      }))
    });
  } catch (err) {
    console.error('[GET /v1/metrics/charging-mix] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ========= HEATMAP =========
router.get('/heatmap', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30*24*60*60*1000);
    const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();

    const r = await sb.rpc('metrics_heatmap', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      grid: (r.data || []).map((x: any) => ({
        dow: Number(x.dow),
        hour: Number(x.hour),
        sessions: Number(x.sessions),
        energy_kwh: Number(x.energy_kwh),
        revenue_br: Number(x.revenue_br)
      }))
    });
  } catch (err) {
    console.error('[GET /v1/metrics/heatmap] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ========= REVENUE / MONTHLY =========
router.get('/revenue/monthly', async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.query.year || new Date().getUTCFullYear()), 10);
    const from = new Date(Date.UTC(year, 0, 1));
    const to   = new Date(Date.UTC(year + 1, 0, 1));

    const r = await sb.rpc('metrics_revenue_monthly', {
      p_from: from.toISOString(),
      p_to: to.toISOString()
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ year, months: r.data || [] });
  } catch (err) {
    console.error('[GET /v1/metrics/revenue/monthly] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ========= TIMESERIES =========
router.get('/timeseries', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 7*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const cbId = norm(q.charge_box_id) ?? null;
    const gran = (q.granularity || 'day').toLowerCase();
    const granSafe: 'hour'|'day'|'month' = (['hour','day','month'].includes(gran) ? gran : 'day') as any;

    const r = await sb.rpc('metrics_timeseries', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_charge_box_id: cbId,
      p_granularity: granSafe
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({
      granularity: granSafe,
      points: (r.data || []).map((x: any) => ({
        ts: new Date(x.ts).toISOString(),
        sessions: Number(x.sessions),
        energy_kwh: Number(x.energy_kwh),
        revenue_br: Number(x.revenue_br),
      })),
    });
  } catch (err) {
    console.error('[GET /v1/metrics/timeseries] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ========= TOPS =========
router.get('/top/chargeboxes', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const limit = Math.min(Math.max(parseInt(String(q.limit||'10'),10) || 10, 1), 100);

    const r = await sb.rpc('metrics_top_chargeboxes', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_limit: limit
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ items: r.data || [] });
  } catch (err) {
    console.error('[GET /v1/metrics/top/chargeboxes] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/top/id-tags', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const limit = Math.min(Math.max(parseInt(String(q.limit||'10'),10) || 10, 1), 100);

    const r = await sb.rpc('metrics_top_id_tags', {
      p_from: from.toISOString(),
      p_to: to.toISOString(),
      p_limit: limit
    });
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ items: r.data || [] });
  } catch (err) {
    console.error('[GET /v1/metrics/top/id-tags] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ========= STATUS =========
router.get('/chargeboxes/status', async (_req: Request, res: Response) => {
  try {
    const r = await sb.rpc('metrics_chargeboxes_status');
    if (r.error) return res.status(500).json({ error: 'rpc_error', detail: r.error.message });

    return res.json({ items: (r.data || []).map((x: any) => ({
      charge_box_id: x.charge_box_id,
      last_event_at: new Date(x.last_event_at).toISOString(),
      recent: x.recent === true,
      active_sessions: Number(x.active_sessions || 0),
    }))});
  } catch (err) {
    console.error('[GET /v1/metrics/chargeboxes/status] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ========= EXPORT =========
router.get('/export/sessions.csv', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const cbId = norm(q.charge_box_id) ?? null;

    const r = await sb
      .from('session_financials')
      .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason, status, duration_seconds, energy_kwh, revenue_br')
      .gte('started_at', from.toISOString())
      .lt('started_at', to.toISOString())
      .order('started_at', { ascending: false })
      .limit(10000)
      .maybeSingle(); // ⚠️ se for grande, troque por RPC que já rende o CSV.

    const rows: any[] = r.data ? [r.data] : [];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sessions.csv"');
    const header = [
      'transaction_id','charge_box_id','id_tag',
      'started_at','stopped_at','stop_reason',
      'status','duration_seconds','energy_kwh','revenue_br'
    ].join(',');
    const lines = rows.map((x: any) => ([
      x.transaction_id, x.charge_box_id, x.id_tag ?? '',
      new Date(x.started_at).toISOString(),
      x.stopped_at ? new Date(x.stopped_at).toISOString() : '',
      x.stop_reason ?? '',
      x.status,
      x.duration_seconds,
      x.energy_kwh ?? '',
      x.revenue_br ?? ''
    ].join(',')));
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    console.error('[GET /v1/metrics/export/sessions.csv] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
