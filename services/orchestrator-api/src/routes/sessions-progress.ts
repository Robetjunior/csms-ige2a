import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { pg } from '../db';

const router = Router();
const TxParam = z.object({ transactionId: z.coerce.number().int().positive() });

function extractTelemetry(p: any): { wh?: number; soc?: number; power_kw?: number; voltage_v?: number; current_a?: number; temperature_c?: number } {
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
        const val = Number((sv.value ?? '').toString().trim());
        if (!Number.isFinite(val)) continue;
        if (!meas || /Energy\.Active\.Import\.Register/i.test(meas)) wh = val; // Wh acumulado
        if (/Power\.Active\.Import/i.test(meas)) power_kw = val >= 100 ? Number((val/1000).toFixed(3)) : Number(val.toFixed(3));
        if (/Voltage/i.test(meas)) voltage_v = Number(val.toFixed(2));
        if (/Current\.(Import|Export)/i.test(meas) || /^Current$/i.test(meas)) current_a = Number(val.toFixed(2));
        if (/Temperature/i.test(meas)) temperature_c = Number(val.toFixed(1));
        if (/^SoC$/i.test(meas)) soc = Math.round(val);
      }
    }
    return { wh, soc, power_kw, voltage_v, current_a, temperature_c };
  } catch { return {} as any; }
}

router.get('/:transactionId/progress', async (req: Request, res: Response) => {
  const parsed = TxParam.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_transaction_id' });
  const tx = parsed.data.transactionId;

  try {
    // Sessão
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
    const now = s.rows[0].stopped_at ? new Date(s.rows[0].stopped_at) : new Date();
    const duration_seconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));

    // MeterStart
    const rStart = await pg.query<{ payload: any }>(
      `SELECT payload
         FROM orchestrator.ocpp_events
        WHERE event_type = $1 AND transaction_id = $2
        ORDER BY id ASC
        LIMIT 1`,
      ['StartTransaction', tx]
    );
    const meterStartWh = Number((rStart.rows[0]?.payload?.meterStart ?? 0)) || 0;

    // Último MeterValues
    const rLast = await pg.query<{ payload: any }>(
      `SELECT payload
         FROM orchestrator.ocpp_events
        WHERE event_type = $1 AND transaction_id = $2
        ORDER BY id DESC
        LIMIT 1`,
      ['MeterValues', tx]
    );

    let meterLatestWh = meterStartWh;
    let soc_percent_at: number | undefined;
    let power_kw: number | undefined;
    let voltage_v: number | undefined;
    let current_a: number | undefined;
    let temperature_c: number | undefined;
    const lastPayload = rLast.rows[0]?.payload;
    if (lastPayload) {
      const { wh, soc, power_kw: pk, voltage_v: vv, current_a: ca, temperature_c: tc } = extractTelemetry(lastPayload);
      if (typeof wh === 'number') meterLatestWh = wh;
      if (typeof soc === 'number') soc_percent_at = soc;
      power_kw = pk; voltage_v = vv; current_a = ca; temperature_c = tc;
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
  } catch (e) {
    console.error('[progress] error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
