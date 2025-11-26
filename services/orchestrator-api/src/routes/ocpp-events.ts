// src/routes/ocpp-events.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';
import { upsertSessionStart } from '../services/repo';

const router = Router();

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

      try {
        await upsertSessionStart({
          transactionId,
          chargeBoxId: chargeBoxId ?? null,
          idTag: idTag ?? null,
          startedAt: timestamp,
          connectorId: connectorId ?? null,
          mode: null,
        });
      } catch (e: any) {
        console.warn('[OCPP] upsertSessionStart(PG) falhou:', e?.message || e);
      }

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
      let meterStop = meterStart;
      if (typeof (payload as any)?.meterStop === 'number') {
        meterStop = Number((payload as any).meterStop);
      } else if (Array.isArray((payload as any)?.transactionData)) {
        // Buscar último sampledValue com measurand=Energy.Active.Import.Register
        const txData = (payload as any).transactionData as any[];
        for (let i = txData.length - 1; i >= 0; i--) {
          const entry = txData[i];
          if (Array.isArray(entry?.sampledValue)) {
            for (const sv of entry.sampledValue) {
              if (sv?.measurand === 'Energy.Active.Import.Register' && typeof sv?.value === 'string') {
                const val = Number(sv.value);
                if (Number.isFinite(val)) {
                  meterStop = val;
                  break;
                }
              }
            }
            if (meterStop !== meterStart) break;
          }
        }
      }

      // 2.4 Calcular energia e duração
      const kwh = Math.max(0, (meterStop - meterStart) / 1000);
      const startTime = startEv.data ? new Date(startEv.data.created_at) : new Date(timestamp.getTime() - 3600000);
      const duration_ms = timestamp.getTime() - startTime.getTime();
      const duration_minutes = Math.max(0, duration_ms / 60000);

      // 2.5 Buscar sessão para billing
      const sess = await sb
        .from('sessions')
        .select('id, charge_box_id, started_at')
        .eq('transaction_id', transactionId)
        .single();

      if (sess.error) {
        console.error('[StopTransaction] load session error', sess.error);
        return res.status(202).json({ accepted: true, idempotentDuplicate: false });
      }

      const s = sess.data as any;

      // 2.6 Buscar snapshot de tarifa
      const snap = await sb
        .from('tariff_snapshots')
        .select('connection_fee, price_kwh, idle_threshold_minutes, idle_price_per_minute')
        .eq('charge_box_id', s.charge_box_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (snap.error) {
        console.error('[StopTransaction] load tariff snapshot error', snap.error);
      }

      // 2.7 Calcular billing
      const connection_br = Number(snap?.data?.connection_fee ?? 0);
      const price_kwh = Number(snap?.data?.price_kwh ?? 0);
      const idle_threshold = Number(snap?.data?.idle_threshold_minutes ?? 30);
      const idle_price = Number(snap?.data?.idle_price_per_minute ?? 0);

      const energy_br = kwh * price_kwh;
      const idle_minutes = Math.max(0, duration_minutes - idle_threshold);
      const idle_br = idle_minutes * idle_price;
      const total_br = connection_br + energy_br + idle_br;

      // 2.8 Upsert invoice
      const inv = await sb
        .from('invoices')
        .upsert({
          session_fk: s.id,
          charge_box_id: s.charge_box_id,
          transaction_id: transactionId,
          started_at: s.started_at,
          stopped_at: timestamp.toISOString(),
          energy_kwh: kwh,
          idle_minutes,
          total_br,
          breakdown: {
            connection_br: Number(snap?.data?.connection_fee ?? 0),
            energy_br,
            idle_br,
            price_kwh: Number(snap?.data?.price_kwh ?? 0),
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

export default router;