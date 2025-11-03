// src/routes/events.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';

const router = Router();

// =======================
// Helpers
// =======================
function extractWhFromMeterValues(payload: any): number | undefined {
  try {
    const arr = payload?.meterValue || payload?.meterValues || payload?.transactionData || [];
    for (const mv of arr) {
      const samples = mv?.sampledValue || [];
      for (const sv of samples) {
        const meas = (sv?.measurand || '').toString();
        const val = Number((sv?.value ?? '').toString().trim());
        if (!Number.isFinite(val)) continue;
        // Energia acumulada (Wh): Energy.Active.Import.Register
        if (!meas || /Energy\.Active\.Import\.Register/i.test(meas)) {
          return val;
        }
      }
    }
  } catch {}
  return undefined;
}

async function resolveTariffSnapshot(
  charge_box_id: string | null,
  mode: 'AC' | 'DC' | 'ANY',
  atISO: string
): Promise<{
  tariff_id: number | null,
  price_kwh: number,
  connection_fee: number,
  idle_fee_per_minute: number,
  idle_grace_minutes: number,
  mode: 'AC'|'DC'|'ANY'
} | null> {
  const r = await sb.rpc('resolve_tariff', {
    p_charge_box_id: charge_box_id,
    p_mode: mode,
    p_at: atISO,
  });
  if (r.error || !r.data?.length) return null;
  const t = r.data[0];
  return {
    tariff_id: Number(t.id),
    price_kwh: Number(t.price_kwh),
    connection_fee: Number(t.connection_fee),
    idle_fee_per_minute: Number(t.idle_fee_per_minute),
    idle_grace_minutes: Number(t.idle_grace_minutes),
    mode,
  };
}

// =======================
// GET /v1/events (consulta)
// =======================
router.get('/', async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const {
      event_type,
      charge_box_id,
      connector_pk,
      transaction_pk,
      id_tag,
      from,
      to,
      limit = '50',
      offset = '0',
      sort = 'desc',
    } = q;

    const parsedLimit = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 500);
    const parsedOffset = Math.max(parseInt(String(offset), 10) || 0, 0);
    const orderAsc = (sort || 'desc').toLowerCase() === 'asc';

    let qry = sb
      .from('events')
      .select('id, created_at, source, event_type, charge_box_id, connector_pk, transaction_pk, id_tag, payload', { count: 'exact' })
      .order('created_at', { ascending: orderAsc })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    if (event_type) qry = qry.eq('event_type', event_type);
    if (charge_box_id) qry = qry.eq('charge_box_id', charge_box_id);
    if (connector_pk) qry = qry.eq('connector_pk', Number(connector_pk));
    if (transaction_pk) qry = qry.eq('transaction_pk', Number(transaction_pk));
    if (id_tag) qry = qry.eq('id_tag', id_tag);
    if (from) qry = qry.gte('created_at', new Date(from).toISOString());
    if (to) qry = qry.lt('created_at', new Date(to).toISOString());

    const r = await qry;
    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });

    return res.json({ total: r.count ?? 0, items: r.data });
  } catch (err) {
    console.error('[GET /v1/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// =======================
// POST /v1/ocpp/events (OCPP -> DB)
// =======================
const OcppEventSchema = z.object({
  type: z.string(),                         // ex: StatusNotification | StartTransaction | MeterValues | StopTransaction
  transactionId: z.number().int().optional(),
  chargeBoxId: z.string().optional(),
  idTag: z.string().optional(),
  reason: z.string().optional(),            // StopTransaction.reason
  timestamp: z.string().datetime().optional(),
  payload: z.any().optional(),              // corpo bruto do Call.req
});

router.post('/events', async (req: Request, res: Response) => {
  try {
    const parsed = OcppEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })) });
    }

    const b = parsed.data;
    const type = String(b.type).trim();
    const transactionId = b.transactionId ?? null;
    const chargeBoxId = b.chargeBoxId ?? null;
    const idTag = b.idTag ?? null;
    const reason = b.reason ?? null;
    const timestamp = b.timestamp ? new Date(b.timestamp) : new Date();
    const payload = b.payload ?? (req.body ?? {});

    // 1) Persistir o evento OCPP bruto
    const ins = await sb
      .from('ocpp_events')
      .insert({
        event_type: type,
        transaction_id: transactionId,
        charge_box_id: chargeBoxId,
        id_tag: idTag,
        payload,
        created_at: timestamp.toISOString(),
      })
      .select('id')
      .single();

    if (ins.error) return res.status(500).json({ error: 'insert_error', detail: ins.error.message });

    // 2) Reações por tipo de evento
    if (type === 'StartTransaction' && transactionId != null) {
      // tentar inferir connectorId do payload
      const connectorId =
        (payload as any)?.connectorId ??
        (req.body as any)?.payload?.connectorId ??
        null;

      // upsert sessão
      await sb
        .from('sessions')
        .upsert({
          transaction_id: transactionId,
          charge_box_id: chargeBoxId,
          id_tag: idTag,
          started_at: timestamp.toISOString(),
          connector_id: connectorId ?? null,
        }, { onConflict: 'transaction_id' });

      // (opcional) marcar RemoteStart como accepted se houver comando pendente
      await sb
        .from('commands')
        .update({ status: 'accepted', updated_at: new Date().toISOString(), response: { acknowledgedBy: 'StartTransaction' } })
        .eq('command_type', 'RemoteStart')
        .eq('charge_box_id', chargeBoxId ?? '')
        .in('status', ['pending','sent']);
    }

    // ======== FECHO DE BILLING NO StopTransaction ========
    else if (type === 'StopTransaction' && transactionId != null) {
      // 2.1 Atualiza sessão com data de parada e reason
      const updSess = await sb
        .from('sessions')
        .update({
          stopped_at: timestamp.toISOString(),
          stop_reason: reason ?? 'Unknown'
        })
        .eq('transaction_id', transactionId);

      if (updSess.error) {
        console.error('[StopTransaction] update session error', updSess.error);
        // continua; tentaremos ainda assim calcular fatura
      }

      // 2.2 Buscar meterStart do StartTransaction
      const startEv = await sb
        .from('ocpp_events')
        .select('payload, created_at')
        .eq('event_type', 'StartTransaction')
        .eq('transaction_id', transactionId)
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (startEv.error) {
        console.error('[StopTransaction] load StartTransaction error', startEv.error);
      }

      const meterStart = startEv.data ? Number((startEv.data as any).payload?.meterStart ?? 0) : 0;

      // 2.3 Determinar meterStop
      // Preferir payload.meterStop (campo canônico do OCPP), com fallback para meterValues/transactionData
      let meterStop: number = Number((payload as any)?.meterStop ?? NaN);
      if (!Number.isFinite(meterStop)) {
        const wh = extractWhFromMeterValues(payload);
        if (typeof wh === 'number' && Number.isFinite(wh)) meterStop = wh;
      }
      if (!Number.isFinite(meterStop)) meterStop = meterStart; // fallback conservador

      const kwh = Math.max(0, (meterStop - meterStart) / 1000);

      // 2.4 Carregar sessão para snapshot/tarifa
      const sess = await sb
        .from('sessions')
        .select('id, started_at, pricing_snapshot, charge_box_id, id_tag, mode')
        .eq('transaction_id', transactionId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (sess.error || !sess.data) {
        console.error('[StopTransaction] session load error or not found', sess.error);
        // Mesmo sem sessão, encerramos 202; mas não conseguimos faturar
        return res.status(202).json({ accepted: true, idempotentDuplicate: false, billed: false, reason: 'session_not_found' });
      }

      const s: any = sess.data;
      const snapshot = s.pricing_snapshot || null;

      // 2.5 Resolver snapshot caso não exista (segurança)
      let snap = snapshot;
      if (!snap) {
        const mode: 'AC'|'DC'|'ANY' = (s.mode === 'AC' || s.mode === 'DC') ? s.mode : 'ANY';
        const fallbackSnap = await resolveTariffSnapshot(s.charge_box_id ?? null, mode, (s.started_at as string));
        if (fallbackSnap) {
          snap = {
            tariff_id: fallbackSnap.tariff_id,
            mode: fallbackSnap.mode,
            price_kwh: fallbackSnap.price_kwh,
            connection_fee: fallbackSnap.connection_fee,
            idle_fee_per_minute: fallbackSnap.idle_fee_per_minute,
            idle_grace_minutes: fallbackSnap.idle_grace_minutes,
          };
          // opcional: persistir o snapshot agora que temos
          await sb.from('sessions').update({ pricing_snapshot: snap }).eq('id', s.id);
        }
      }

      // 2.6 Calcular valores
      let energy_br = 0, idle_minutes = 0, idle_br = 0, total_br = 0;
      if (snap) {
        energy_br = kwh * Number(snap.price_kwh ?? 0);
        // idle_*: aqui 0. Se você quiser cobrar idle real, some via eventos ou regra externa.
        total_br = Number(snap.connection_fee ?? 0) + energy_br + idle_br;
      }

      // 2.7 Atualizar sessão com energia/total
      const upd = await sb
        .from('sessions')
        .update({ energy_kwh: kwh, revenue_br: total_br })
        .eq('id', s.id);

      if (upd.error) {
        console.error('[StopTransaction] update session energy/total error', upd.error);
      }

      // 2.8 Upsert invoice
      const inv = await sb
        .from('invoices')
        .upsert({
          session_fk: s.id,
          transaction_id: transactionId,
          charge_box_id: s.charge_box_id,
          id_tag: s.id_tag,
          started_at: s.started_at,
          stopped_at: timestamp.toISOString(),
          energy_kwh: kwh,
          idle_minutes,
          total_br,
          breakdown: {
            connection_br: Number(snap?.connection_fee ?? 0),
            energy_br,
            idle_br,
            price_kwh: Number(snap?.price_kwh ?? 0),
          }
        }, { onConflict: 'session_fk' })
        .select('id')
        .single();

      if (inv.error) {
        console.error('[StopTransaction] upsert invoice error', inv.error);
      }

      // 2.9 Completar comando RemoteStop (se existir)
      await sb
        .from('commands')
        .update({ status: 'accepted', response: payload, updated_at: new Date().toISOString() })
        .eq('command_type', 'RemoteStop')
        .eq('transaction_id', transactionId)
        .in('status', ['pending','sent']);
    }

    // 3) OK
    return res.status(202).json({ accepted: true, idempotentDuplicate: false });
  } catch (err) {
    console.error('[POST /v1/ocpp/events] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// =======================
// GET /v1/events/:id
// =======================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    const r = await sb
      .from('events')
      .select('id, created_at, source, event_type, charge_box_id, connector_pk, transaction_pk, id_tag, payload')
      .eq('id', id)
      .single();

    if (r.error?.code === 'PGRST116') return res.status(404).json({ error: 'not_found' });
    if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });

    return res.json(r.data);
  } catch (err) {
    console.error('[GET /v1/events/:id] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
