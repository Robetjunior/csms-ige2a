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
 * GET /v1/metrics/utilization?from&to&charge_box_id
 * Utilização = tempo de sessão (somatório) / tempo disponível no período.
 * Obs: aproxima usando duration_seconds das sessões (não depende de StatusNotification).
 */
router.get('/utilization', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 7*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();
    const cbId = norm(String(req.query.charge_box_id)) ?? null;

    const sql = `
      WITH base AS (
        SELECT charge_box_id, duration_seconds
        FROM orchestrator.session_metrics
        WHERE started_at >= $1 AND started_at < $2
          AND ($3::text IS NULL OR charge_box_id = $3)
      ),
      agg AS (
        SELECT charge_box_id, COALESCE(SUM(duration_seconds),0)::bigint AS busy_seconds
        FROM base
        GROUP BY charge_box_id
      )
      SELECT
        a.charge_box_id,
        a.busy_seconds,
        EXTRACT(EPOCH FROM ($2::timestamptz - $1::timestamptz))::bigint AS period_seconds,
        ROUND(100.0 * a.busy_seconds / NULLIF(EXTRACT(EPOCH FROM ($2::timestamptz - $1::timestamptz)),0), 2) AS utilization_pct
      FROM agg a
      ORDER BY utilization_pct DESC NULLS LAST, a.charge_box_id;
    `;
    const { rows } = await pg.query(sql, [from, to, cbId]);
    res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items: rows });
  } catch (err) {
    console.error('[utilization] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/reliability?from&to
 * Confiabilidade: taxa de sucesso de sessões (com energia > 0), falhas, média de duração.
 * (Se quiser, inclua dados de commands RemoteStart/RemoteStop para uma taxa de aceitação.)
 */
router.get('/reliability', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const sql = `
      WITH base AS (
        SELECT status, COALESCE(energy_kwh,0) AS energy_kwh, duration_seconds
        FROM orchestrator.session_financials
        WHERE started_at >= $1 AND started_at < $2
      )
      SELECT
        COUNT(*) AS sessions_total,
        COUNT(*) FILTER (WHERE energy_kwh > 0) AS sessions_success,
        COUNT(*) FILTER (WHERE energy_kwh = 0) AS sessions_zero_kwh,
        ROUND(100.0 * COUNT(*) FILTER (WHERE energy_kwh > 0) / NULLIF(COUNT(*),0), 2) AS success_pct,
        (COALESCE(AVG(duration_seconds),0))::int AS avg_duration_seconds
      FROM base;
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({ period: { from: from.toISOString(), to: to.toISOString() }, ...rows[0] });
  } catch (err) {
    console.error('[reliability] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/funnel?from&to
 * Funil: StartTransaction -> Energia>0 -> Completed
 */
router.get('/funnel', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const sql = `
      WITH starts AS (
        SELECT COUNT(DISTINCT transaction_id) AS started
        FROM orchestrator.ocpp_events
        WHERE tipo='StartTransaction' AND created_at >= $1 AND created_at < $2
      ),
      sess AS (
        SELECT COUNT(*) AS sessions_total,
               COUNT(*) FILTER (WHERE COALESCE(energy_kwh,0) > 0) AS energy_sessions,
               COUNT(*) FILTER (WHERE status='completed')           AS completed_sessions
        FROM orchestrator.session_financials
        WHERE started_at >= $1 AND started_at < $2
      )
      SELECT s.started, f.sessions_total, f.energy_sessions, f.completed_sessions
      FROM starts s CROSS JOIN sess f;
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({ period: { from: from.toISOString(), to: to.toISOString() }, ...rows[0] });
  } catch (err) {
    console.error('[funnel] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/arpu?from&to
 * Receita média por usuário (id_tag): revenue / distinct id_tag.
 */
router.get('/arpu', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const sql = `
      WITH base AS (
        SELECT id_tag, COALESCE(revenue_br,0) AS revenue_br
        FROM orchestrator.session_financials
        WHERE started_at >= $1 AND started_at < $2
      )
      SELECT
        COALESCE(SUM(revenue_br),0) AS revenue_total_br,
        COUNT(DISTINCT id_tag) FILTER (WHERE id_tag IS NOT NULL AND id_tag <> '') AS users,
        ROUND(COALESCE(SUM(revenue_br),0) / NULLIF(COUNT(DISTINCT id_tag) FILTER (WHERE id_tag IS NOT NULL AND id_tag <> ''),0), 2) AS arpu_br
      FROM base;
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({ period: { from: from.toISOString(), to: to.toISOString() }, ...rows[0] });
  } catch (err) {
    console.error('[arpu] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/cohorts/monthly?year=2025
 * Cohort simples: usuários "novos" por mês e receita do mês.
 */
router.get('/cohorts/monthly', async (req: Request, res: Response) => {
  try {
    const year = parseInt(String(req.query.year || new Date().getUTCFullYear()), 10);
    const from = new Date(Date.UTC(year, 0, 1));
    const to   = new Date(Date.UTC(year+1, 0, 1));

    const sql = `
      WITH first_seen AS (
        SELECT id_tag, MIN(date_trunc('month', started_at)) AS cohort_month
        FROM orchestrator.session_financials
        WHERE id_tag IS NOT NULL AND id_tag <> ''
        GROUP BY id_tag
      ),
      base AS (
        SELECT date_trunc('month', f.started_at) AS month,
               COUNT(DISTINCT f.id_tag) AS active_users,
               COUNT(DISTINCT CASE WHEN fs.cohort_month = date_trunc('month', f.started_at) THEN f.id_tag END) AS new_users,
               COALESCE(SUM(f.revenue_br),0) AS revenue_br
        FROM orchestrator.session_financials f
        LEFT JOIN first_seen fs ON fs.id_tag = f.id_tag
        WHERE f.started_at >= $1 AND f.started_at < $2
        GROUP BY 1
      )
      SELECT to_char(month, 'YYYY-MM') AS month,
             active_users, new_users, revenue_br
      FROM base
      ORDER BY month ASC;
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({ year, months: rows });
  } catch (err) {
    console.error('[cohorts/monthly] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/anomalies?from&to
 * Anomalias simples: sessões fora de 3x o desvio padrão em kWh ou duração.
 */
router.get('/anomalies', async (req: Request, res: Response) => {
  try {
    const from = parseDateISO(String(req.query.from)) ?? new Date(Date.now() - 30*24*60*60*1000);
    const to   = parseDateISO(String(req.query.to))   ?? new Date();

    const sql = `
      WITH base AS (
        SELECT transaction_id, charge_box_id, id_tag, started_at, stopped_at,
               COALESCE(energy_kwh,0) AS energy_kwh, duration_seconds
        FROM orchestrator.session_financials
        WHERE started_at >= $1 AND started_at < $2
      ),
      stats AS (
        SELECT
          AVG(energy_kwh) AS avg_kwh, STDDEV_POP(energy_kwh) AS sd_kwh,
          AVG(duration_seconds) AS avg_dur, STDDEV_POP(duration_seconds) AS sd_dur
        FROM base
      )
      SELECT b.*,
             CASE WHEN sd_kwh=0 THEN false ELSE ABS(b.energy_kwh - avg_kwh) > 3*sd_kwh END AS outlier_kwh,
             CASE WHEN sd_dur=0 THEN false ELSE ABS(b.duration_seconds - avg_dur) > 3*sd_dur END AS outlier_duration
      FROM base b CROSS JOIN stats
      WHERE (CASE WHEN sd_kwh=0 THEN false ELSE ABS(b.energy_kwh - avg_kwh) > 3*sd_kwh END)
         OR (CASE WHEN sd_dur=0 THEN false ELSE ABS(b.duration_seconds - avg_dur) > 3*sd_dur END)
      ORDER BY b.started_at DESC
      LIMIT 100;
    `;
    const { rows } = await pg.query(sql, [from, to]);
    res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items: rows });
  } catch (err) {
    console.error('[anomalies] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/forecast/revenue?months=3
 * Projeção simples: média móvel dos últimos 3 meses.
 */
router.get('/forecast/revenue', async (req: Request, res: Response) => {
  try {
    const months = Math.min(Math.max(parseInt(String(req.query.months || '3'),10) || 3, 1), 12);

    const sql = `
      WITH hist AS (
        SELECT date_trunc('month', started_at) AS month,
               COALESCE(SUM(revenue_br),0) AS revenue_br
        FROM orchestrator.session_financials
        GROUP BY 1
      ),
      ma AS (
        SELECT month, revenue_br,
               AVG(revenue_br) OVER (ORDER BY month ROWS BETWEEN $1 PRECEDING AND CURRENT ROW) AS mov_avg
        FROM hist
        ORDER BY month
      ),
      last AS (
        SELECT mov_avg FROM ma ORDER BY month DESC LIMIT 1
      )
      SELECT (SELECT mov_avg FROM last) AS next_month_revenue_br;
    `;
    const { rows } = await pg.query(sql, [months - 1]);
    res.json({ months_window: months, projection: Number(rows[0]?.next_month_revenue_br ?? 0) });
  } catch (err) {
    console.error('[forecast/revenue] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/metrics/live (SSE)
 * Stream de KPIs a cada N segundos (para dashboard sem polling pesado).
 */
router.get('/live', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const tick = async () => {
    try {
      const q = `
        SELECT
          (SELECT COUNT(*) FROM orchestrator.session_metrics WHERE status='active') AS active_sessions,
          COALESCE((SELECT SUM(energy_kwh) FROM orchestrator.session_financials WHERE started_at >= now()::date),0) AS today_kwh,
          COALESCE((SELECT SUM(revenue_br) FROM orchestrator.session_financials WHERE started_at >= now()::date),0) AS today_revenue
      `;
      const { rows } = await pg.query(q);
      res.write(`data: ${JSON.stringify(rows[0])}\n\n`);
    } catch (err) {
      console.error('[live] error:', err);
      res.write(`event: error\ndata: "internal_error"\n\n`);
    }
  };

  const iv = setInterval(tick, 5000);
  // dispara primeira
  tick();

  req.on('close', () => clearInterval(iv));
});

export default router;
