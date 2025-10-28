import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';
import { z } from 'zod';

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
        const valStr = (sv.value ?? '').toString().trim();
        const val = Number(valStr);
        if (!Number.isFinite(val)) continue;

        // Energia acumulada (Wh) geralmente: Energy.Active.Import.Register
        if (!meas || /Energy\.Active\.Import\.Register/i.test(meas)) wh = val;
        // Potência ativa de importação (geralmente em W). Converte para kW se necessário.
        if (/Power\.Active\.Import/i.test(meas)) power_kw = val >= 100 ? Number((val / 1000).toFixed(3)) : Number(val.toFixed(3));
        // Tensão (V)
        if (/Voltage/i.test(meas)) voltage_v = Number(val.toFixed(2));
        // Corrente (A)
        if (/Current\.(Import|Export)/i.test(meas) || /^Current$/i.test(meas)) current_a = Number(val.toFixed(2));
        // Temperatura (°C)
        if (/Temperature/i.test(meas)) temperature_c = Number(val.toFixed(1));
        // Estado de carga (%)
        if (/^SoC$/i.test(meas)) soc = Math.round(val);
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
    const s = await sb
      .from('sessions')
      .select('started_at, stopped_at')
      .eq('transaction_id', tx)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (s.error) return res.status(500).json({ error:'query_error', detail: s.error.message });
    if (!s.data) return res.status(404).json({ error:'session_not_found' });

    const startedAt = new Date((s.data as any).started_at);
    const baseNow = (s.data as any).stopped_at ? new Date((s.data as any).stopped_at) : new Date();
    const duration_seconds = Math.max(0, Math.floor((baseNow.getTime() - startedAt.getTime())/1000));

    // 2) meterStart (StartTransaction)
    const startEv = await sb
      .from('ocpp_events')
      .select('payload')
      .eq('tipo', 'StartTransaction')
      .eq('transaction_id', tx)
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (startEv.error) return res.status(500).json({ error:'query_error', detail: startEv.error.message });
    const meterStartWh = Number((startEv.data as any)?.payload?.meterStart ?? 0) || 0;

    // 3) último MeterValues
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
      const { wh, soc, power_kw: pk, voltage_v: vv, current_a: ca, temperature_c: tc } = extractTelemetryFromMeterValuesPayload((lastMv.data as any).payload);
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
    if (to) q = q.lt('started_at', new Date(to).toISOString());

    const r = await q;
    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });

    return res.json({ total: r.count ?? 0, items: r.data });
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

    const r = await sb
      .from('sessions')
      .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason')
      .eq('charge_box_id', chargeBoxId)
      .is('stopped_at', null)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });
    if (!r.data) return res.json({ session: null });

    const s: any = r.data;
    const duration_seconds = Math.floor((new Date().getTime() - new Date(s.started_at).getTime())/1000);

    return res.json({ 
      session: {
        ...s, 
        status: 'active', 
        duration_seconds,
        isActive: true
      }
    });
  } catch (err: any) {
    console.error('[GET /v1/sessions/active/:chargeBoxId] error:', err);
    return res.status(500).json({ error: 'internal_error' });
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

    const r = await sb
      .from('sessions')
      .select('transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason')
      .eq('transaction_id', tx)
      .order('id', { ascending: false })
      .limit(1)
      .single();

    if (r.error?.code === 'PGRST116') return res.status(404).json({ error: 'not_found' });
    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });

    const s: any = r.data;
    const duration_seconds = Math.floor((new Date(s.stopped_at ?? new Date()).getTime() - new Date(s.started_at).getTime())/1000);
    const status = s.stopped_at ? 'completed' : 'active';

    return res.json({ ...s, status, duration_seconds });
  } catch (err: any) {
    console.error('[GET /v1/sessions/:id] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
