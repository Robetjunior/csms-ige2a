import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';

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
    const s = await sb
      .from('sessions')
      .select('started_at, stopped_at')
      .eq('transaction_id', tx)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (s.error) return res.status(500).json({ error: 'query_error', detail: s.error.message });
    if (!s.data) return res.status(404).json({ error: 'session_not_found' });

    const startedAt = new Date((s.data as any).started_at);
    const now = (s.data as any).stopped_at ? new Date((s.data as any).stopped_at) : new Date();
    const duration_seconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));

    const startEv = await sb
      .from('ocpp_events')
      .select('payload')
      .eq('tipo', 'StartTransaction')
      .eq('transaction_id', tx)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (startEv.error) return res.status(500).json({ error: 'query_error', detail: startEv.error.message });
    const meterStartWh = Number((startEv.data as any)?.payload?.meterStart ?? 0) || 0;

    const lastMv = await sb
      .from('ocpp_events')
      .select('payload')
      .eq('tipo', 'MeterValues')
      .eq('transaction_id', tx)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    let meterLatestWh = meterStartWh;
    let soc_percent_at: number | undefined;
    let power_kw: number | undefined;
    let voltage_v: number | undefined;
    let current_a: number | undefined;
    let temperature_c: number | undefined;
    if (!lastMv.error && lastMv.data) {
      const { wh, soc, power_kw: pk, voltage_v: vv, current_a: ca, temperature_c: tc } = extractTelemetry((lastMv.data as any).payload);
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
