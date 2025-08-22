// src/routes/metrics.ts
import { Router, Request, Response } from 'express';
import { pg } from '../db';

const router = Router();

function norm(s?: string) { return (s ?? '').trim() || undefined; }
function parseDateISO(s?: string) {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * GET /v1/metrics/overview?from&to&charge_box_id
 */
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const cbId = norm(q.charge_box_id) ?? null;

    const sql = `
      WITH base AS (
        SELECT * FROM orchestrator.session_financials
        WHERE started_at >= $1 AND started_at < $2
          AND ($3::text IS NULL OR charge_box_id = $3)
      )
      SELECT
        (SELECT COUNT(*) FROM orchestrator.events WHERE created_at >= $1 AND created_at < $2) AS events,
        (SELECT COUNT(*) FROM base) AS sessions,
        (SELECT COUNT(*) FROM base WHERE status='active') AS active_sessions,
        (SELECT COUNT(DISTINCT charge_box_id) FROM base) AS unique_charge_boxes,
        COALESCE(SUM(energy_kwh),0) AS energy_kwh,
        COALESCE(SUM(revenue_br),0) AS revenue_br,
        COALESCE(AVG(duration_seconds)/60,0)::int AS avg_session_minutes
      FROM base
    `;
    const { rows } = await pg.query(sql, [from, to, cbId]);
    const r = rows[0] || {};
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
      health: { ready: true, pg: 'up' }
    });
  } catch (err) {
    console.error('[GET /v1/metrics/overview] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v1/metrics/charging-mix?from&to
router.get('/charging-mix', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30*24*60*60*1000);
    const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();

    const sql = `
      SELECT mode, COUNT(*) AS sessions,
             COALESCE(SUM(energy_kwh),0) AS energy_kwh,
             COALESCE(SUM(revenue_br),0) AS revenue_br
        FROM orchestrator.session_financials
       WHERE started_at >= $1 AND started_at < $2
       GROUP BY mode
       ORDER BY revenue_br DESC NULLS LAST
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      items: rows.map(r => ({ mode: r.mode, sessions: Number(r.sessions), energy_kwh: Number(r.energy_kwh), revenue_br: Number(r.revenue_br) }))
    });
  } catch (err) {
    console.error('[GET /v1/metrics/charging-mix] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

router.get('/heatmap', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30*24*60*60*1000);
    const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();

    const sql = `
      SELECT EXTRACT(DOW  FROM started_at)::int AS dow,   -- 0=domingo
             EXTRACT(HOUR FROM started_at)::int AS hour,
             COUNT(*) AS sessions,
             COALESCE(SUM(energy_kwh),0) AS energy_kwh,
             COALESCE(SUM(revenue_br),0) AS revenue_br
        FROM orchestrator.session_financials
       WHERE started_at >= $1 AND started_at < $2
       GROUP BY 1,2
       ORDER BY 1,2
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({
      period: { from: from.toISOString(), to: to.toISOString() },
      grid: rows.map(r => ({
        dow: Number(r.dow),
        hour: Number(r.hour),
        sessions: Number(r.sessions),
        energy_kwh: Number(r.energy_kwh),
        revenue_br: Number(r.revenue_br),
      }))
    });
  } catch (err) {
    console.error('[GET /v1/metrics/heatmap] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});


// GET /v1/metrics/revenue/monthly?year=2025
router.get('/revenue/monthly', async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.query.year || new Date().getUTCFullYear()), 10);
    const from = new Date(Date.UTC(year, 0, 1));
    const to   = new Date(Date.UTC(year + 1, 0, 1));

    const sql = `
      SELECT to_char(date_trunc('month', started_at), 'YYYY-MM') AS month,
             COUNT(*) AS sessions,
             COALESCE(SUM(energy_kwh),0) AS energy_kwh,
             COALESCE(SUM(revenue_br),0) AS revenue_br
        FROM orchestrator.session_financials
       WHERE started_at >= $1 AND started_at < $2
       GROUP BY 1
       ORDER BY 1 ASC
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({ year, months: rows });
  } catch (err) {
    console.error('[GET /v1/metrics/revenue/monthly] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/timeseries?from&to&granularity=hour|day|month&charge_box_id
 */
router.get('/timeseries', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 7*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const cbId = norm(q.charge_box_id) ?? null;
    const gran = (q.granularity || 'day').toLowerCase();
    const granSafe = ['hour','day','month'].includes(gran) ? gran : 'day';

    const sql = `
      WITH base AS (
        SELECT *
        FROM orchestrator.session_financials
        WHERE started_at >= $1 AND started_at < $2
          AND ($3::text IS NULL OR charge_box_id = $3)
      ),
      binned AS (
        SELECT
          CASE
            WHEN $4 = 'hour'  THEN date_trunc('hour', started_at)
            WHEN $4 = 'month' THEN date_trunc('month', started_at)
            ELSE date_trunc('day', started_at)
          END AS ts,
          energy_kwh,
          revenue_br
        FROM base
      )
      SELECT
        ts,
        COUNT(*) AS sessions,
        COALESCE(SUM(energy_kwh),0) AS energy_kwh,
        COALESCE(SUM(revenue_br),0) AS revenue_br
      FROM binned
      GROUP BY ts
      ORDER BY ts ASC
    `;
    const { rows } = await pg.query(sql, [from, to, cbId, granSafe]);
    return res.json({
      granularity: granSafe,
      points: rows.map(r => ({
        ts: new Date(r.ts).toISOString(),
        sessions: Number(r.sessions),
        energy_kwh: Number(r.energy_kwh),
        revenue_br: Number(r.revenue_br),
      })),
    });
  } catch (err) {
    console.error('[GET /v1/metrics/timeseries] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/top/chargeboxes?from&to&limit=10
 */
router.get('/top/chargeboxes', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const limit = Math.min(Math.max(parseInt(String(q.limit||'10'),10) || 10, 1), 100);

    const sql = `
      SELECT
        charge_box_id,
        COUNT(*) AS sessions,
        COALESCE(SUM(energy_kwh),0) AS energy_kwh,
        COALESCE(SUM(revenue_br),0) AS revenue_br
      FROM orchestrator.session_financials
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY charge_box_id
      ORDER BY revenue_br DESC
      LIMIT $3
    `;
    const { rows } = await pg.query(sql, [from, to, limit]);
    return res.json({ items: rows.map(r => ({
      charge_box_id: r.charge_box_id,
      sessions: Number(r.sessions),
      energy_kwh: Number(r.energy_kwh),
      revenue_br: Number(r.revenue_br),
    }))});
  } catch (err) {
    console.error('[GET /v1/metrics/top/chargeboxes] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/top/id-tags?from&to&limit=10
 */
router.get('/top/id-tags', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const limit = Math.min(Math.max(parseInt(String(q.limit||'10'),10) || 10, 1), 100);

    const sql = `
      SELECT
        id_tag,
        COUNT(*) AS sessions,
        COALESCE(SUM(energy_kwh),0) AS energy_kwh,
        COALESCE(SUM(revenue_br),0) AS revenue_br
      FROM orchestrator.session_financials
      WHERE started_at >= $1 AND started_at < $2
      GROUP BY id_tag
      ORDER BY revenue_br DESC NULLS LAST
      LIMIT $3
    `;
    const { rows } = await pg.query(sql, [from, to, limit]);
    return res.json({ items: rows.map(r => ({
      id_tag: r.id_tag,
      sessions: Number(r.sessions),
      energy_kwh: Number(r.energy_kwh),
      revenue_br: Number(r.revenue_br),
    }))});
  } catch (err) {
    console.error('[GET /v1/metrics/top/id-tags] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/chargeboxes/status
 */
router.get('/chargeboxes/status', async (_req: Request, res: Response) => {
  try {
    const sql = `
      WITH last_ev AS (
        SELECT charge_box_id, MAX(created_at) AS last_event_at
        FROM orchestrator.events
        GROUP BY charge_box_id
      ),
      active AS (
        SELECT charge_box_id, COUNT(*) AS active_sessions
        FROM orchestrator.session_metrics
        WHERE status='active'
        GROUP BY charge_box_id
      )
      SELECT
        l.charge_box_id,
        l.last_event_at,
        (now() - l.last_event_at) <= interval '5 minutes' AS recent,
        COALESCE(a.active_sessions,0) AS active_sessions
      FROM last_ev l
      LEFT JOIN active a USING (charge_box_id)
      ORDER BY l.charge_box_id
    `;
    const { rows } = await pg.query(sql);
    return res.json({ items: rows.map(r => ({
      charge_box_id: r.charge_box_id,
      last_event_at: new Date(r.last_event_at).toISOString(),
      recent: r.recent === true,
      active_sessions: Number(r.active_sessions),
    }))});
  } catch (err) {
    console.error('[GET /v1/metrics/chargeboxes/status] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/export/sessions.csv?from&to&charge_box_id
 */
router.get('/export/sessions.csv', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const from = parseDateISO(q.from) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(q.to)   ?? new Date();
    const cbId = norm(q.charge_box_id) ?? null;

    const sql = `
      SELECT
        transaction_id, charge_box_id, id_tag,
        started_at, stopped_at, stop_reason,
        status, duration_seconds, energy_kwh, revenue_br
      FROM orchestrator.session_financials
      WHERE started_at >= $1 AND started_at < $2
        AND ($3::text IS NULL OR charge_box_id = $3)
      ORDER BY started_at DESC
      LIMIT 10000
    `;
    const { rows } = await pg.query(sql, [from, to, cbId]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sessions.csv"');
    const header = [
      'transaction_id','charge_box_id','id_tag',
      'started_at','stopped_at','stop_reason',
      'status','duration_seconds','energy_kwh','revenue_br'
    ].join(',');
    const lines = rows.map(r => ([
      r.transaction_id,
      r.charge_box_id,
      r.id_tag ?? '',
      new Date(r.started_at).toISOString(),
      r.stopped_at ? new Date(r.stopped_at).toISOString() : '',
      r.stop_reason ?? '',
      r.status,
      r.duration_seconds,
      r.energy_kwh ?? '',
      r.revenue_br ?? ''
    ].join(',')));
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    console.error('[GET /v1/metrics/export/sessions.csv] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
