import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';

const router = Router();
const TxParam = z.object({ transactionId: z.coerce.number().int().positive() });

function extractMeterAndSoc(p: any): { wh?: number; soc?: number } {
  try {
    const arr = p?.meterValue || p?.meterValues || [];
    let wh: number | undefined;
    let soc: number | undefined;
    for (const mv of arr) {
      const samples = mv?.sampledValue || [];
      for (const sv of samples) {
        const meas = (sv.measurand || '').toString();
        const val = Number((sv.value ?? '').toString().trim());
        if (!Number.isFinite(val)) continue;
        if (!meas || /Energy\.Active\.Import\.Register/i.test(meas)) wh = val; // Wh acumulado
        if (/^SoC$/i.test(meas)) soc = val;
      }
    }
    return { wh, soc };
  } catch { return {}; }
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
    if (!lastMv.error && lastMv.data) {
      const { wh, soc } = extractMeterAndSoc((lastMv.data as any).payload);
      if (typeof wh === 'number') meterLatestWh = wh;
      if (typeof soc === 'number') soc_percent_at = soc;
    }

    const kwh = Math.max(0, (meterLatestWh - meterStartWh) / 1000);
    return res.json({
      kwh: Number(kwh.toFixed(3)),
      duration_seconds,
      ...(soc_percent_at != null ? { soc_percent_at: Math.round(soc_percent_at) } : {})
    });
  } catch (e) {
    console.error('[progress] error:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
