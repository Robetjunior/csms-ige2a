import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pg } from '../db';

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

router.post('/estimate', async (req: Request, res: Response) => {
  // atalho para /tariffs/preview, mas mantido por semântica
  const { charge_box_id, connector_id, mode='AC', expected_kwh=0, expected_minutes=0, active_at } = req.body || {};
  const at = active_at ? new Date(active_at) : new Date();

  const { rows } = await pg.query(`SELECT * FROM orchestrator.resolve_tariff($1,$2,$3)`, [charge_box_id ?? null, String(mode).toUpperCase(), at]);
  if (!rows.length) return res.status(404).json({ error: 'tariff_not_found' });
  const t = rows[0];

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

router.post('/start', async (req: Request, res: Response) => {
  const parsed = StartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const b = parsed.data;

  const started_at = b.started_at ? new Date(b.started_at) : new Date();
  const mode = (b.mode ?? 'AC').toUpperCase();

  // resolve tarifa
  const { rows: tariffRows } = await pg.query(`SELECT * FROM orchestrator.resolve_tariff($1,$2,$3)`, [b.charge_box_id, mode, started_at]);
  if (!tariffRows.length) return res.status(404).json({ error: 'tariff_not_found' });
  const t = tariffRows[0];

  const snapshot = {
    tariff_id: t.id,
    mode,
    price_kwh: Number(t.price_kwh),
    connection_fee: Number(t.connection_fee),
    idle_fee_per_minute: Number(t.idle_fee_per_minute),
    idle_grace_minutes: Number(t.idle_grace_minutes),
  };

  // grava na sessão (upsert por transaction_id)
  await pg.query(
    `INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, connector_id, mode, started_at, pricing_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (transaction_id) DO UPDATE
       SET charge_box_id=EXCLUDED.charge_box_id,
           id_tag=COALESCE(EXCLUDED.id_tag, orchestrator.sessions.id_tag),
           connector_id=COALESCE(EXCLUDED.connector_id, orchestrator.sessions.connector_id),
           mode=EXCLUDED.mode,
           started_at=LEAST(orchestrator.sessions.started_at, EXCLUDED.started_at),
           pricing_snapshot=EXCLUDED.pricing_snapshot`,
    [b.transaction_id, b.charge_box_id, b.id_tag ?? null, b.connector_id ?? null, mode, started_at, JSON.stringify(snapshot)]
  );

  return res.status(201).json({ transaction_id: b.transaction_id, pricing_snapshot: snapshot });
});

router.post('/refresh', async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const b = parsed.data;

  // tentar achar meterStart do StartTransaction; se não houver, 0
  const { rows: startEv } = await pg.query(
    `SELECT payload FROM orchestrator.ocpp_events
      WHERE tipo='StartTransaction' AND transaction_id=$1
      ORDER BY id ASC LIMIT 1`, [b.transaction_id]);
  const meterStart = startEv.length ? Number(startEv[0].payload?.meterStart ?? 0) : 0;

  const kwh = Math.max(0, (b.meterLatest - meterStart) / 1000.0);

  const { rows: sess } = await pg.query(
    `SELECT pricing_snapshot, started_at FROM orchestrator.sessions WHERE transaction_id=$1 LIMIT 1`,
    [b.transaction_id]
  );
  if (!sess.length) return res.status(404).json({ error: 'session_not_found' });

  const snap = sess[0].pricing_snapshot || {};
  const duration_seconds = Math.floor((Date.now() - new Date(sess[0].started_at).getTime())/1000);

  const energy_br = kwh * Number(snap.price_kwh ?? 0);
  const idle_minutes = 0; // live simplificado (idle final é fechado no close)
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

router.post('/close', async (req: Request, res: Response) => {
  const parsed = CloseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const b = parsed.data;

  const { rows: srows } = await pg.query(
    `SELECT id, started_at, pricing_snapshot, charge_box_id, id_tag
     FROM orchestrator.sessions WHERE transaction_id=$1 LIMIT 1`, [b.transaction_id]);
  if (!srows.length) return res.status(404).json({ error: 'session_not_found' });
  const s = srows[0];

  const stopped_at = b.stopped_at ? new Date(b.stopped_at) : new Date();
  const duration_seconds = Math.max(0, Math.floor((stopped_at.getTime() - new Date(s.started_at).getTime())/1000));
  const kwh = Math.max(0, (b.meterStop - b.meterStart) / 1000.0);

  const snap = s.pricing_snapshot || {};
  const energy_br = kwh * Number(snap.price_kwh ?? 0);
  // idle simplificado = 0 (calcular via StatusNotification se disponível)
  const idle_minutes = 0;
  const idle_br = 0;
  const total_br = Number(snap.connection_fee ?? 0) + energy_br + idle_br;

  // atualiza sessão e cria invoice
  await pg.query(
    `UPDATE orchestrator.sessions
       SET stopped_at=$2, stop_reason=COALESCE(stop_reason,'Remote'),
           energy_kwh=$3, revenue_br=$4
     WHERE id=$1`, [s.id, stopped_at, kwh, total_br]
  );

  const { rows: inv } = await pg.query(
    `INSERT INTO orchestrator.invoices
      (session_fk, transaction_id, charge_box_id, id_tag, started_at, stopped_at,
       energy_kwh, idle_minutes, total_br, breakdown)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (session_fk) DO UPDATE
       SET stopped_at=EXCLUDED.stopped_at,
           energy_kwh=EXCLUDED.energy_kwh,
           idle_minutes=EXCLUDED.idle_minutes,
           total_br=EXCLUDED.total_br,
           breakdown=EXCLUDED.breakdown
     RETURNING id`,
    [s.id, b.transaction_id, s.charge_box_id, s.id_tag,
     s.started_at, stopped_at, kwh, idle_minutes, total_br,
     JSON.stringify({ connection_br: Number(snap.connection_fee ?? 0), energy_br, idle_br, price_kwh: Number(snap.price_kwh ?? 0) })]
  );

  return res.json({
    transaction_id: b.transaction_id,
    invoice_id: inv[0].id,
    totals: { energy_kwh: kwh, duration_seconds, total_br },
  });
});

// GET /v1/billing/invoices?from&to&charge_box_id&id_tag&limit=100
router.get('/invoices', async (req: Request, res: Response) => {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30*24*60*60*1000);
    const to   = req.query.to   ? new Date(String(req.query.to))   : new Date();
    const cb   = (req.query.charge_box_id as string|undefined)?.trim() || null;
    const idTag= (req.query.id_tag as string|undefined)?.trim() || null;
    const limit= Math.min(Math.max(parseInt(String(req.query.limit||'100'),10) || 100, 1), 1000);

    const sql = `
      SELECT id, session_fk, transaction_id, charge_box_id, id_tag,
             started_at, stopped_at, energy_kwh, idle_minutes, total_br, breakdown
        FROM orchestrator.invoices
       WHERE started_at >= $1 AND started_at < $2
         AND ($3::text IS NULL OR charge_box_id = $3)
         AND ($4::text IS NULL OR id_tag = $4)
       ORDER BY started_at DESC
       LIMIT $5
    `;
    const { rows } = await pg.query(sql, [from, to, cb, idTag, limit]);
    res.json({ items: rows });
  } catch (err) {
    console.error('[GET /v1/billing/invoices] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v1/billing/invoices/:id
router.get('/invoices/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });

    const sql = `
      SELECT id, session_fk, transaction_id, charge_box_id, id_tag,
             started_at, stopped_at, energy_kwh, idle_minutes, total_br, breakdown
        FROM orchestrator.invoices
       WHERE id = $1::bigint
       LIMIT 1
    `;
    const { rows } = await pg.query(sql, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /v1/billing/invoices/:id] error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
