import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';
import { pg } from '../db';
import { csms } from '../ocpp/csms';
import { withTimeout } from '../helpers/withTimeout';

const router = Router();

const RemoteStartSchema = z.object({
  chargeBoxId: z.string().min(1),
  idTag: z.string().min(1),
  connectorId: z.number().int().positive().optional(),
});

router.post('/remoteStart', async (req: Request, res: Response) => {
  const parsed = RemoteStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const { chargeBoxId, idTag, connectorId } = parsed.data;
  const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
  const RESEND_OLDER_THAN_MS = 15000;

  let idemRow: any | null = null;
  let idem = sb
    .from('commands')
    .select('id,status,payload,created_at,updated_at')
    .eq('command_type', 'RemoteStart')
    .eq('charge_box_id', chargeBoxId)
    .filter('payload->>idTag', 'eq', idTag)
    .in('status', ['pending', 'sent', 'accepted'])
    .order('id', { ascending: false })
    .limit(1);
  if (typeof connectorId === 'number') idem = idem.filter('payload->>connectorId', 'eq', String(connectorId));
  else idem = idem.is('payload->connectorId', null);
  const idemRes: any = await withTimeout<any>(idem as any);
  if (idemRes && !idemRes.error && idemRes.data?.length) {
    idemRow = idemRes.data[0];
  } else {
    console.warn('[FALLBACK] Supabase timeout → PG', { route: '/v1/commands/remoteStart', chargeBoxId });
    try {
      const r = await pg.query(
        `SELECT id, status, payload, created_at, updated_at
           FROM orchestrator.commands
          WHERE command_type = 'RemoteStart'
            AND charge_box_id = $1
            AND (payload->>'idTag') = $2
            AND status IN ('pending','sent','accepted')
          ORDER BY id DESC
          LIMIT 1`,
        [chargeBoxId, idTag]
      );
      if ((r.rowCount ?? 0) > 0) idemRow = r.rows[0];
    } catch {}
  }

  if (idemRow) {
    const lastTs = new Date(idemRow.updated_at || idemRow.created_at).getTime();
    const ageMs = Date.now() - lastTs;
    const shouldResend = force || (['pending','sent'].includes(idemRow.status) && ageMs > RESEND_OLDER_THAN_MS);
    if (shouldResend) {
      try {
        await csms.remoteStart(chargeBoxId, { idTag, connectorId });
        await pg.query(`UPDATE orchestrator.commands SET status='sent', updated_at=now() WHERE id=$1`, [idemRow.id]);
        return res.status(202).json({ commandId: idemRow.id, status: 'sent', idempotentDuplicate: true, resent: true });
      } catch (e:any) {
        return res.status(409).json({ commandId: idemRow.id, status: 'pending', idempotentDuplicate: true, error: e?.message || 'charge_point_offline' });
      }
    }
    return res.status(200).json({ commandId: idemRow.id, status: idemRow.status, idempotentDuplicate: true });
  }

  const payload: any = { idTag, ...(connectorId != null ? { connectorId } : {}) };
  let cmdId: number | null = null;
  const ins: any = await withTimeout<any>(
    sb
      .from('commands')
      .insert({
        command_type: 'RemoteStart',
        charge_box_id: chargeBoxId,
        requested_by: 'api',
        status: 'pending',
        payload,
      })
      .select('id')
      .single()
  );
  if (ins && !ins.error && ins.data?.id) {
    cmdId = ins.data.id;
  } else {
    console.warn('[FALLBACK] Supabase timeout → PG', { route: '/v1/commands/remoteStart', chargeBoxId });
    try {
      const r = await pg.query<{ id:number }>(
        `INSERT INTO orchestrator.commands (command_type, charge_box_id, requested_by, status, payload)
         VALUES ('RemoteStart', $1, 'api', 'pending', $2::jsonb)
         RETURNING id`,
        [chargeBoxId, JSON.stringify(payload)]
      );
      cmdId = r.rows[0].id;
    } catch {}
  }

  try {
    await csms.remoteStart(chargeBoxId, { idTag, connectorId });
    if (cmdId != null) {
      const up = await withTimeout<any>(
        sb.from('commands')
          .update({ status: 'sent', updated_at: new Date().toISOString() })
          .eq('id', cmdId!)
      );
      if (!up || up.error) {
        console.warn('[FALLBACK] Supabase timeout → PG', { route: '/v1/commands/remoteStart', chargeBoxId });
        try { await pg.query(`UPDATE orchestrator.commands SET status='sent', updated_at=now() WHERE id=$1`, [cmdId!]); } catch {}
      }
    }
    return res.status(202).json({ commandId: cmdId ?? undefined, status: 'sent' });
  } catch (e:any) {
    return res.status(409).json({ commandId: cmdId!, status: 'pending', error: e?.message || 'charge_point_offline' });
  }
});

export default router;
router.post('/remoteStop', async (req: Request, res: Response) => {
  const Body = z.object({ transactionId: z.number().int().positive(), chargeBoxId: z.string().optional() });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  const { transactionId, chargeBoxId } = parsed.data;
  let cmdId: number | undefined;
  try {
    const ins = await withTimeout<any>(
      sb
        .from('commands')
        .insert({ command_type: 'RemoteStop', charge_box_id: chargeBoxId ?? null, requested_by: 'api', status: 'pending', payload: { transactionId } })
        .select('id')
        .single()
    );
    if (ins && !ins.error && ins.data?.id) cmdId = ins.data.id;
  } catch {}
  try {
    await csms.remoteStop(transactionId, chargeBoxId);
    try {
      if (cmdId != null) {
        const up = await withTimeout<any>(sb.from('commands').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', cmdId));
        if (!up || up.error) { try { await pg.query(`UPDATE orchestrator.commands SET status='sent', updated_at=now() WHERE id=$1`, [cmdId]); } catch {} }
      }
    } catch {}
    return res.status(202).json({ commandId: cmdId, status: 'sent' });
  } catch (e: any) {
    return res.status(409).json({ commandId: cmdId, status: 'pending', error: e?.message || 'charge_point_offline' });
  }
});
