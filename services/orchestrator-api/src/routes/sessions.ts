import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';
import { z } from 'zod';
import { pg } from '../db';

const router = Router();

const TxParam = z.object({ transactionId: z.coerce.number().int().positive() });

function extractTelemetryFromMeterValuesPayload(p: any): { wh?: number; soc?: number; power_kw?: number; voltage_v?: number; current_a?: number; temperature_c?: number } {
  try {
    const arr = p?.meterValue || p?.meterValues || [];
    let wh: number | undefined;
    let soc: number | undefined;
    let power_kw: number | undefined;
    let voltage_v: number | undefined;
    let current_a: number | undefined;
    let temperature_c: number | undefined;

    for (const mv of arr) {
      const samples = mv?.sampledValue || [];
      for (const sv of samples) {
        const meas = (sv.measurand || '').toString();
        const unit = (sv.unit || '').toString();
        const valStr = (sv.value ?? '').toString().trim();
        const val = Number(valStr);
        if (!Number.isFinite(val)) continue;

        // Energia acumulada: Energy.Active.Import.Register
        if (!meas || /Energy\.Active\.Import\.Register/i.test(meas)) {
          if (/^Wh$/i.test(unit)) {
            wh = val;
          } else if (/^kWh$/i.test(unit)) {
            wh = val * 1000; // converte para Wh para cálculo relativo com meterStartWh
          } else {
            // sem unidade explícita, assumir Wh conforme OCPP 1.6
            wh = val;
          }
        }
        // Potência ativa de importação: Power.Active.Import
        if (/Power\.Active\.Import/i.test(meas)) {
          if (/^W$/i.test(unit) || unit === '') {
            power_kw = Number((val / 1000).toFixed(3));
          } else if (/^kW$/i.test(unit)) {
            power_kw = Number(val.toFixed(3));
          } else {
            // fallback conservador: tratar como W
            power_kw = Number((val / 1000).toFixed(3));
          }
        }
        // Tensão (V)
        if (/Voltage/i.test(meas)) {
          // unidades comuns: V
          voltage_v = Number(val.toFixed(2));
        }
        // Corrente (A)
        if (/Current\.(Import|Export)/i.test(meas) || /^Current$/i.test(meas)) {
          // unidades comuns: A
          current_a = Number(val.toFixed(2));
        }
        // Temperatura (°C)
        if (/Temperature/i.test(meas)) {
          // unidades comuns: Celsius
          temperature_c = Number(val.toFixed(1));
        }
        // Estado de carga (%)
        if (/^SoC$/i.test(meas)) {
          // unidades comuns: Percent
          soc = Math.round(val);
        }
      }
    }
    return { wh, soc, power_kw, voltage_v, current_a, temperature_c };
  } catch {
    return {} as any;
  }
}

router.get('/:transactionId/progress', async (req: Request, res: Response) => {
  const parsed = TxParam.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error:'invalid_transaction_id' });

  const tx = parsed.data.transactionId;

  try {
    // 1) sessão (para started_at)
    const s = await pg.query<{ started_at: string; stopped_at: string | null }>(
      `SELECT started_at, stopped_at
         FROM orchestrator.sessions
        WHERE transaction_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [tx]
    );
    if (s.rowCount === 0) return res.status(404).json({ error:'session_not_found' });
    const startedAt = new Date(s.rows[0].started_at);
    const baseNow = s.rows[0].stopped_at ? new Date(s.rows[0].stopped_at) : new Date();
    const duration_seconds = Math.max(0, Math.floor((baseNow.getTime() - startedAt.getTime())/1000));

    // 2) meterStart (StartTransaction) — preferir PG com fallback Supabase
    const rStart = await pg.query<{ payload: any }>(
      `SELECT payload
         FROM orchestrator.ocpp_events
        WHERE event_type = $1 AND transaction_id = $2
        ORDER BY id ASC
        LIMIT 1`,
      ['StartTransaction', tx]
    );
    const meterStartWh = Number((rStart.rows[0]?.payload?.meterStart ?? 0)) || 0;

    // 3) último MeterValues — preferir PG com fallback Supabase
    let meterLatestWh = meterStartWh;
    let soc_percent_at: number | undefined;
    let power_kw: number | undefined;
    let voltage_v: number | undefined;
    let current_a: number | undefined;
    let temperature_c: number | undefined;

    const rMv = await pg.query<{ payload: any }>(
      `SELECT payload
         FROM orchestrator.ocpp_events
        WHERE event_type = $1 AND transaction_id = $2
        ORDER BY id DESC
        LIMIT 1`,
      ['MeterValues', tx]
    );
    const lastMvPayload: any = rMv.rows[0]?.payload ?? null;

    if (lastMvPayload) {
      const { wh, soc, power_kw: pk, voltage_v: vv, current_a: ca, temperature_c: tc } = extractTelemetryFromMeterValuesPayload(lastMvPayload);
      if (typeof wh === 'number' && Number.isFinite(wh)) meterLatestWh = wh;
      if (typeof soc === 'number' && Number.isFinite(soc)) soc_percent_at = soc;
      power_kw = pk;
      voltage_v = vv;
      current_a = ca;
      temperature_c = tc;
    }

    const kwh = Math.max(0, (meterLatestWh - meterStartWh) / 1000);

    return res.json({
      kwh: Number(kwh.toFixed(3)),
      duration_seconds,
      started_at: startedAt.toISOString(),
      ...(soc_percent_at != null ? { soc_percent_at: Math.round(soc_percent_at) } : {}),
      ...(power_kw != null ? { power_kw } : {}),
      ...(voltage_v != null ? { voltage_v } : {}),
      ...(current_a != null ? { current_a } : {}),
      ...(temperature_c != null ? { temperature_c } : {})
    });
  } catch (err:any) {
    console.error('[GET /v1/sessions/:transactionId/progress] error:', err);
    return res.status(500).json({ error:'internal_error' });
  }
});

/**
 * GET /v1/sessions/:transactionId/telemetry — payload canônico para o app
 */
router.get('/:transactionId/telemetry', async (req: Request, res: Response) => {
  const parsed = TxParam.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_transaction_id' });
  const tx = parsed.data.transactionId;

  try {
    // 1) sessão (started_at, stopped_at)
    const s = await pg.query<{ started_at: string; stopped_at: string | null }>(
      `SELECT started_at, stopped_at
         FROM orchestrator.sessions
        WHERE transaction_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [tx]
    );
    if (s.rowCount === 0) return res.status(404).json({ error: 'session_not_found' });
    const startedAt = new Date(s.rows[0].started_at);
    const baseNow = s.rows[0].stopped_at ? new Date(s.rows[0].stopped_at) : new Date();
    const duration_seconds = Math.max(0, Math.floor((baseNow.getTime() - startedAt.getTime()) / 1000));

    // 2) tentar telemetry_latest primeiro
    const rTl = await pg.query<{
      energy_kwh: number | null;
      power_kw: number | null;
      voltage_v: number | null;
      current_a: number | null;
      soc_percent: number | null;
      temperature_c: number | null;
      at: string;
    }>(
      `SELECT energy_kwh, power_kw, voltage_v, current_a, soc_percent, temperature_c, at
         FROM orchestrator.telemetry_latest
        WHERE transaction_id = $1
        ORDER BY connector_id ASC
        LIMIT 1`,
      [tx]
    );

    let energy_kwh: number | undefined;
    let power_kw: number | undefined;
    let voltage_v: number | undefined;
    let current_a: number | undefined;
    let soc_percent_at: number | undefined;
    let temperature_c: number | undefined;

    if (rTl.rowCount > 0) {
      const t = rTl.rows[0];
      if (t.energy_kwh != null) energy_kwh = Number(t.energy_kwh);
      if (t.power_kw != null) power_kw = Number(t.power_kw);
      if (t.voltage_v != null) voltage_v = Number(t.voltage_v);
      if (t.current_a != null) current_a = Number(t.current_a);
      if (t.soc_percent != null) soc_percent_at = Math.round(Number(t.soc_percent));
      if (t.temperature_c != null) temperature_c = Number(t.temperature_c);
    } else {
      // 3) fallback: calcular a partir de StartTransaction/MeterValues
      const rStart = await pg.query<{ payload: any }>(
        `SELECT payload
           FROM orchestrator.ocpp_events
          WHERE event_type = $1 AND transaction_id = $2
          ORDER BY id ASC
          LIMIT 1`,
        ['StartTransaction', tx]
      );
      const meterStartWh = Number((rStart.rows[0]?.payload?.meterStart ?? 0)) || 0;

      const rMv = await pg.query<{ payload: any }>(
        `SELECT payload
           FROM orchestrator.ocpp_events
          WHERE event_type = $1 AND transaction_id = $2
          ORDER BY id DESC
          LIMIT 1`,
        ['MeterValues', tx]
      );
      const lastMvPayload: any = rMv.rows[0]?.payload ?? null;
      if (lastMvPayload) {
        const { wh, soc, power_kw: pk, voltage_v: vv, current_a: ca, temperature_c: tc } = extractTelemetryFromMeterValuesPayload(lastMvPayload);
        if (typeof wh === 'number' && Number.isFinite(wh)) energy_kwh = Number(Math.max(0, (wh - meterStartWh) / 1000).toFixed(3));
        if (typeof soc === 'number' && Number.isFinite(soc)) soc_percent_at = Math.round(soc);
        power_kw = pk; voltage_v = vv; current_a = ca; temperature_c = tc;
      }
    }

    // 4) unit_price / total_amount — opcional
    let unit_price: number | undefined;
    let total_amount: number | undefined;
    try {
      const rBill = await pg.query<{ unit_price: number | null; total_amount: number | null }>(
        `SELECT unit_price, total_amount
           FROM orchestrator.sessions
          WHERE transaction_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [tx]
      );
      if (rBill.rowCount > 0) {
        if (rBill.rows[0].unit_price != null) unit_price = Number(rBill.rows[0].unit_price);
        if (rBill.rows[0].total_amount != null) total_amount = Number(rBill.rows[0].total_amount);
      }
    } catch {}

    return res.json({
      kwh: energy_kwh != null ? Number(Number(energy_kwh).toFixed(3)) : undefined,
      duration_seconds,
      started_at: startedAt.toISOString(),
      ...(power_kw != null ? { power_kw } : {}),
      ...(voltage_v != null ? { voltage_v } : {}),
      ...(current_a != null ? { current_a } : {}),
      ...(temperature_c != null ? { temperature_c } : {}),
      ...(soc_percent_at != null ? { soc_percent_at } : {}),
      ...(unit_price != null ? { unit_price } : {}),
      ...(total_amount != null ? { total_amount } : {}),
      at: new Date().toISOString(),
    });
  } catch (err:any) {
    console.error('[GET /v1/sessions/:transactionId/telemetry] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/sessions
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      charge_box_id,
      id_tag,
      transaction_id,
      status,
      from,
      to,
      limit = '50',
      offset = '0',
      sort = 'desc',
    } = req.query as Record<string, string | undefined>;

    const parsedLimit = Math.min(Math.max(parseInt(String(limit) || '50', 10), 1), 500);
    const parsedOffset = Math.max(parseInt(String(offset) || '0', 10), 0);
    const orderAsc = (sort || 'desc').toLowerCase() === 'asc';

    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (charge_box_id) { where.push(`s.charge_box_id = $${i++}`); params.push(charge_box_id); }
    if (id_tag)       { where.push(`s.id_tag = $${i++}`);       params.push(id_tag); }
    if (transaction_id) { where.push(`s.transaction_id = $${i++}::int`); params.push(Number(transaction_id)); }
    if (status === 'active') { where.push(`s.stopped_at IS NULL`); }
    if (status === 'completed') { where.push(`s.stopped_at IS NOT NULL`); }
    if (from) { where.push(`s.started_at >= $${i++}`); params.push(new Date(from).toISOString()); }
    if (to)   { where.push(`s.started_at <= $${i++}`); params.push(new Date(to).toISOString()); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT
        (s.transaction_id)::int AS transaction_id,
        s.charge_box_id,
        s.id_tag,
        s.started_at,
        s.stopped_at,
        s.stop_reason,
        s.mode,
        s.energy_kwh,
        s.revenue_br
      FROM orchestrator.sessions s
      ${whereSql}
      ORDER BY s.started_at ${orderAsc ? 'ASC' : 'DESC'}
      LIMIT $${i++}
      OFFSET $${i++}
    `;

    try {
      const r = await pg.query(sql, [...params, parsedLimit, parsedOffset]);
      return res.json({ total: r.rowCount, items: r.rows });
    } catch {
      if (!sb) throw new Error('db_unavailable');
      let q = sb
        .from('sessions')
        .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason, mode, energy_kwh, revenue_br', { count: 'exact' })
        .order('started_at', { ascending: orderAsc })
        .range(parsedOffset, parsedOffset + parsedLimit - 1);

      if (charge_box_id) q = q.eq('charge_box_id', charge_box_id);
      if (id_tag) q = q.eq('id_tag', id_tag);
      if (transaction_id) q = q.eq('transaction_id', Number(transaction_id));
      if (status === 'active') q = q.is('stopped_at', null);
      if (status === 'completed') q = q.not('stopped_at', 'is', null);
      if (from) q = q.gte('started_at', new Date(from).toISOString());
      if (to)   q = q.lte('started_at', new Date(to).toISOString());

      const r2 = await q;
      if (r2.error) return res.status(500).json({ error: 'query_error', detail: r2.error.message });
      return res.json({ total: r2.count ?? 0, items: r2.data });
    }
  } catch (err: any) {
    console.error('[GET /v1/sessions] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/sessions/active/:chargeBoxId
 * Busca a sessão ativa de um carregador específico
 */
router.get('/active/:chargeBoxId', async (req: Request, res: Response) => {
  try {
    const chargeBoxId = String(req.params.chargeBoxId || '').trim();
    if (!chargeBoxId) {
      return res.status(400).json({ error: 'invalid_charge_box_id' });
    }

    try {
      const r = await pg.query<{
        transaction_id: number;
        charge_box_id: string;
        id_tag: string | null;
        started_at: string;
        stopped_at: string | null;
        stop_reason: string | null;
      }>(
        `SELECT transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason
           FROM orchestrator.sessions
          WHERE charge_box_id = $1 AND stopped_at IS NULL
          ORDER BY id DESC
          LIMIT 1`,
        [chargeBoxId]
      );

      if (r.rowCount === 0) return res.json({ session: null });

      const s = r.rows[0] as any;
      const duration_seconds = Math.floor((new Date().getTime() - new Date(s.started_at).getTime())/1000);

      return res.json({ 
        session: {
          ...s, 
          status: 'active', 
          duration_seconds,
          isActive: true
        }
      });
    } catch {
      if (!sb) throw new Error('db_unavailable');
      const r2 = await sb
        .from('sessions')
        .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason')
        .eq('charge_box_id', chargeBoxId)
        .is('stopped_at', null)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (r2.error) return res.status(500).json({ error: 'query_error', detail: r2.error.message });
      if (!r2.data) return res.json({ session: null });
      const s: any = r2.data;
      const duration_seconds = Math.floor((Date.now() - new Date(s.started_at).getTime())/1000);
      return res.json({
        session: {
          ...s,
          status: 'active',
          duration_seconds,
          isActive: true,
        }
      });
    }
  } catch (err: any) {
    console.error('[GET /v1/sessions/active/:chargeBoxId] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/sessions/active/:chargeBoxId/detail
 * Retorna detalhes da sessão ativa de um carregador específico, incluindo telemetria
 */
router.get('/active/:chargeBoxId/detail', async (req: Request, res: Response) => {
  try {
    const chargeBoxId = String(req.params.chargeBoxId || '').trim();
    if (!chargeBoxId) return res.status(400).json({ error: 'invalid_charge_box_id' });

    // Buscar sessão ativa: preferir Postgres com fallback Supabase para evitar 500 por TLS
    let s: any;
    let tx: number;
    let duration_seconds: number;
    try {
      const r = await pg.query<{
        transaction_id: number;
        charge_box_id: string;
        id_tag: string | null;
        started_at: string;
        stopped_at: string | null;
        stop_reason: string | null;
      }>(
        `SELECT transaction_id, charge_box_id, id_tag,
                started_at, stopped_at, stop_reason
           FROM orchestrator.sessions
          WHERE charge_box_id = $1 AND stopped_at IS NULL
          ORDER BY id DESC
          LIMIT 1`,
        [chargeBoxId]
      );
      if (r.rowCount === 0) return res.json({ session: null, telemetry: null });
      s = r.rows[0] as any;
    } catch {
      // Fallback via Supabase REST (cert válido) apenas para a sessão
      if (!sb) throw new Error('db_unavailable');
      const r2 = await sb
        .from('sessions')
        .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason')
        .eq('charge_box_id', chargeBoxId)
        .is('stopped_at', null)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (r2.error) return res.status(500).json({ error: 'query_error', detail: r2.error.message });
      if (!r2.data) return res.json({ session: null, telemetry: null });
      s = r2.data as any;
    }
    tx = Number(s.transaction_id);
    duration_seconds = Math.max(0, Math.floor((Date.now() - new Date(s.started_at).getTime()) / 1000));

    // Telemetria — envolver tudo em try/catch para robustez
    let telemetry: any = { kwh: 0 };
    try {
      // MeterStart a partir do StartTransaction — preferir PG com fallback Supabase
      let meterStartWh = 0;
      try {
        const rStart = await pg.query<{ payload: any }>(
          `SELECT payload
             FROM orchestrator.ocpp_events
            WHERE event_type = $1 AND transaction_id = $2
            ORDER BY id ASC
            LIMIT 1`,
          ['StartTransaction', tx]
        );
        meterStartWh = Number((rStart.rows[0]?.payload?.meterStart ?? 0)) || 0;
      } catch {
        // Fallback Supabase removido para evitar erros TLS em ambientes com interceptadores.
      }

      // Último MeterValues para telemetria — preferir PG com fallback Supabase
      let lastMvPayload: any = null;
      try {
        const rMv = await pg.query<{ payload: any }>(
          `SELECT payload
             FROM orchestrator.ocpp_events
            WHERE event_type = $1 AND transaction_id = $2
            ORDER BY id DESC
            LIMIT 1`,
          ['MeterValues', tx]
        );
        lastMvPayload = rMv.rows[0]?.payload ?? null;
      } catch {
        // Fallback Supabase removido por confiabilidade.
      }

      if (lastMvPayload) {
        const { wh, soc, power_kw, voltage_v, current_a, temperature_c } = extractTelemetryFromMeterValuesPayload(lastMvPayload);
        const meterLatestWh = (typeof wh === 'number' && Number.isFinite(wh)) ? wh : meterStartWh;
        const kwh = Math.max(0, (meterLatestWh - meterStartWh) / 1000);
        telemetry = {
          kwh: Number(kwh.toFixed(3)),
          ...(soc != null ? { soc_percent_at: Math.round(soc) } : {}),
          ...(power_kw != null ? { power_kw } : {}),
          ...(voltage_v != null ? { voltage_v } : {}),
          ...(current_a != null ? { current_a } : {}),
          ...(temperature_c != null ? { temperature_c } : {}),
        };
      }
    } catch {
      telemetry = { kwh: 0 };
    }

    const session = {
      transaction_id: tx,
      charge_box_id: s.charge_box_id,
      id_tag: s.id_tag,
      connector_id: s.connector_id ?? null,
      mode: s.mode ?? null,
      started_at: s.started_at,
      status: 'active',
      duration_seconds,
      isActive: true,
    };

    return res.json({ session, telemetry });
  } catch (err: any) {
    console.error('[GET /v1/sessions/active/:chargeBoxId/detail] error:', err);
    return res.status(500).json({ error: 'internal_error', detail: err?.message || String(err) });
  }
});

/**
 * GET /v1/sessions/:transactionId
 */
router.get('/:transactionId', async (req: Request, res: Response) => {
  try {
    const tx = Number(req.params.transactionId);
    if (!Number.isFinite(tx)) {
      return res.status(400).json({ error: 'invalid_transaction_id' });
    }

    try {
      const r = await pg.query<{
        transaction_id: number;
        charge_box_id: string;
        id_tag: string | null;
        started_at: string;
        stopped_at: string | null;
        stop_reason: string | null;
      }>(
        `SELECT transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason
           FROM orchestrator.sessions
          WHERE transaction_id = $1
          ORDER BY id DESC
          LIMIT 1`,
        [tx]
      );

      if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });

      const s = r.rows[0] as any;
      const duration_seconds = Math.floor((new Date(s.stopped_at ?? new Date()).getTime() - new Date(s.started_at).getTime())/1000);
      const status = s.stopped_at ? 'completed' : 'active';

      return res.json({ ...s, status, duration_seconds });
    } catch {
      if (!sb) throw new Error('db_unavailable');
      const r2 = await sb
        .from('sessions')
        .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason')
        .eq('transaction_id', tx)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (r2.error?.code === 'PGRST116') return res.status(404).json({ error: 'not_found' });
      if (r2.error) return res.status(500).json({ error: 'query_error', detail: r2.error.message });
      if (!r2.data) return res.status(404).json({ error: 'not_found' });

      const s: any = r2.data;
      const duration_seconds = Math.floor((new Date(s.stopped_at ?? new Date()).getTime() - new Date(s.started_at).getTime())/1000);
      const status = s.stopped_at ? 'completed' : 'active';
      return res.json({ ...s, status, duration_seconds });
    }
  } catch (err: any) {
    console.error('[GET /v1/sessions/:id] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
