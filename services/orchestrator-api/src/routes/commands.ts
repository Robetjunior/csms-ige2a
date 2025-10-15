// src/routes/commands.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';
import { csms } from '../ocpp/csms';

const router = Router();

/* ===== Schemas ===== */
const RemoteStartSchema = z.object({
  chargeBoxId: z.string().min(1),
  idTag: z.string().min(1),
  connectorId: z.number().int().positive().optional(),
});

const RemoteStopSchema = z.object({
  transactionId: z.number().int().positive(),
});

const ResetSchema = z.object({
  chargeBoxId: z.string().min(1),
  type: z.enum(['Soft','Hard']).default('Soft')
});

const ChangeAvailabilitySchema = z.object({
  chargeBoxId: z.string().min(1),
  connectorId: z.number().int().nonnegative(), // 0 = todos
  type: z.enum(['Operative','Inoperative']),
});

router.post('/reset', async (req, res) => {
  const p = ResetSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error:'invalid_payload', details:p.error.issues });
  const { chargeBoxId, type } = p.data;

  // registra comando
  const ins = await sb.from('commands').insert({
    command_type: 'Reset',
    charge_box_id: chargeBoxId,
    status: 'pending',
    requested_by: 'api',
    payload: { type }
  }).select('id').single();
  if (ins.error) return res.status(500).json({ error:'insert_error', detail: ins.error.message });

  const cmdId = ins.data.id;

  try {
    // tenta obter ACK; alguns CPs não respondem e reiniciam (timeout esperado)
    const r = await csms.reset(chargeBoxId, type);
    await sb.from('commands').update({
      status: 'accepted',
      response: r,
      updated_at: new Date().toISOString()
    }).eq('id', cmdId);

    return res.status(202).json({ commandId: cmdId, status:'accepted', response: r });
  } catch (e:any) {
    const msg = String(e?.message || '');

    // CP offline de verdade -> 409
    if (/charge_point_offline/i.test(msg)) {
      await sb.from('commands').update({ status:'pending', response:{ error:'offline' }, updated_at: new Date().toISOString() }).eq('id', cmdId);
      return res.status(409).json({ commandId: cmdId, status:'pending', error:'charge_point_offline', detail: msg });
    }

    // ⚠️ Timeout do Reset = comportamento comum (CP reinicia sem ACK).
    if (/timeout waiting CallResult for Reset/i.test(msg)) {
      await sb.from('commands').update({
        status: 'sent',
        response: { note: 'no_ack_timeout' },
        updated_at: new Date().toISOString()
      }).eq('id', cmdId);

      return res.status(202).json({
        commandId: cmdId,
        status: 'sent',
        message: 'Reset enviado; sem ACK (comum). O CP deve reiniciar e reconectar em seguida.'
      });
    }

    // Qualquer outro erro inesperado
    await sb.from('commands').update({
      status: 'failed',
      response: { error: msg },
      updated_at: new Date().toISOString()
    }).eq('id', cmdId);

    return res.status(500).json({ error:'reset_failed', detail: msg });
  }
});


/* ===== RemoteStart ===== */
router.post('/remoteStart', async (req: Request, res: Response) => {
  const parsed = RemoteStartSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
    });
  }
  const { chargeBoxId, idTag, connectorId } = parsed.data;

  const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true';
  const RESEND_OLDER_THAN_MS = 15000; // reenvia automaticamente se o último "sent/pending" for mais velho que 15s

  // Idempotência (com select incluindo timestamps)
  let idem = sb
    .from('commands')
    .select('id,status,payload,created_at,updated_at')
    .eq('command_type', 'RemoteStart')
    .eq('charge_box_id', chargeBoxId)
    .filter('payload->>idTag', 'eq', idTag)
    .in('status', ['pending', 'sent', 'accepted'])
    .order('id', { ascending: false })
    .limit(1);

  if (typeof connectorId === 'number') {
    idem = idem.filter('payload->>connectorId', 'eq', String(connectorId));
  } else {
    idem = idem.is('payload->connectorId', null);
  }

  const idemRes = await idem;
  if (idemRes.error) {
    return res.status(500).json({ error: 'query_error', detail: idemRes.error.message });
  }

  // Se já existe um comando igual "aberto"
  if (idemRes.data?.length) {
    const row = idemRes.data[0];

    // 1) Se FORCE, reenvia agora usando o mesmo row.id
    // 2) Ou se o último "pending/sent" for velho, reenvia (TTL)
    const lastTs = new Date(row.updated_at || row.created_at).getTime();
    const ageMs = Date.now() - lastTs;
    const shouldResend = force || (['pending','sent'].includes(row.status) && ageMs > RESEND_OLDER_THAN_MS);

    if (shouldResend) {
      try {
        await csms.remoteStart(chargeBoxId, { idTag, connectorId });
        await sb.from('commands')
          .update({ status: 'sent', updated_at: new Date().toISOString() })
          .eq('id', row.id);
        return res.status(202).json({
          commandId: row.id,
          status: 'sent',
          idempotentDuplicate: true,
          resent: true,
          message: 'Reenviado ao CP (force/TTL).',
        });
      } catch (e:any) {
        return res.status(409).json({
          commandId: row.id,
          status: 'pending',
          idempotentDuplicate: true,
          error: e?.message || 'charge_point_offline',
          detail: e?.message || 'CP não conectado ao nosso CSMS',
        });
      }
    }

    // Senão, mantém comportamento anterior
    return res.status(200).json({ commandId: row.id, status: row.status, idempotentDuplicate: true });
  }

  // Não havia idempotente — insere e envia
  const payload: any = { idTag };
  if (connectorId != null) payload.connectorId = connectorId;

  const ins = await sb
    .from('commands')
    .insert({
      command_type: 'RemoteStart',
      charge_box_id: chargeBoxId,
      requested_by: 'api',
      status: 'pending',
      payload,
    })
    .select('id')
    .single();

  if (ins.error) {
    return res.status(500).json({ error: 'insert_error', detail: ins.error.message });
  }

  try {
    await csms.remoteStart(chargeBoxId, { idTag, connectorId });
    await sb.from('commands')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', ins.data.id);
    return res.status(202).json({
      commandId: ins.data.id,
      status: 'sent',
      message: 'RemoteStart enviado ao CP conectado ao nosso CSMS.',
    });
  } catch (e: any) {
    return res.status(409).json({
      commandId: ins.data.id,
      status: 'pending',
      error: e?.message || 'charge_point_offline',
      detail: e?.message || 'CP não conectado ao nosso CSMS',
    });
  }
});


/* ===== RemoteStop ===== */
router.post('/remoteStop', async (req: Request, res: Response) => {
  const parsed = RemoteStopSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
    });
  }
  const tx = parsed.data.transactionId;

  // 🔎 tenta identificar o CP dono do tx (se ainda online)
  const chargeBoxId = csms.resolveTx(tx);

  // idempotência básica
  const existing = await sb
    .from('commands')
    .select('id,status')
    .eq('command_type','RemoteStop')
    .eq('transaction_id', tx)
    .in('status', ['pending','sent','accepted'])
    .order('id', { ascending: false })
    .limit(1);

  if (existing.error) {
    return res.status(500).json({ error: 'query_error', detail: existing.error.message });
  }
  if (existing.data?.length) {
    const row = existing.data[0];
    return res.status(200).json({ commandId: row.id, status: row.status, idempotentDuplicate: true });
  }

  // registra o comando com charge_box_id (quando conhecido)
  const ins = await sb.from('commands').insert({
    command_type: 'RemoteStop',
    transaction_id: tx,
    charge_box_id: chargeBoxId ?? null,  // ✅ NOVO
    requested_by: 'api',
    status: 'pending',
    payload: { transactionId: tx },
  }).select('id').single();

  if (ins.error) {
    return res.status(500).json({ error: 'insert_error', detail: ins.error.message });
  }

  try {
    await csms.remoteStop(tx);
    await sb.from('commands')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', ins.data.id);

    return res.status(202).json({
      commandId: ins.data.id,
      status: 'sent',
      message: 'RemoteStop enviado ao CP conectado ao nosso CSMS.',
    });
  } catch (e: any) {
    return res.status(409).json({
      commandId: ins.data.id,
      status: 'pending',
      error: 'charge_point_offline',
      detail: e?.message || 'charge_point_offline',
    });
  }
});

/* ===== ChangeAvailability ===== */
router.post('/changeAvailability', async (req: Request, res: Response) => {
  const p = ChangeAvailabilitySchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error:'invalid_payload', details: p.error.issues });
  const { chargeBoxId, connectorId, type } = p.data;

  // idempotência
  let q = sb.from('commands')
    .select('id,status,payload')
    .eq('command_type','ChangeAvailability')
    .eq('charge_box_id', chargeBoxId)
    .filter('payload->>connectorId','eq', String(connectorId))
    .filter('payload->>type','eq', type)
    .in('status',['pending','sent','accepted'])
    .order('id',{ ascending:false })
    .limit(1);

  const idem = await q;
  const force = String(req.query.force ?? '') === '1';

  if (idem.error) return res.status(500).json({ error:'query_error', detail: idem.error.message });

  let commandId: number | null = null;
  if (idem.data?.length && !force) {
    const row = idem.data[0];
    return res.status(200).json({ commandId: row.id, status: row.status, idempotentDuplicate: true });
  }

  // cria (ou reaproveita com force)
  if (!idem.data?.length) {
    const ins = await sb.from('commands').insert({
      command_type: 'ChangeAvailability',
      charge_box_id: chargeBoxId,
      status: 'pending',
      requested_by: 'api',
      payload: { connectorId, type }
    }).select('id').single();
    if (ins.error) return res.status(500).json({ error:'insert_error', detail: ins.error.message });
    commandId = ins.data.id;
  } else {
    commandId = idem.data[0].id;
  }

  try {
    const result: any = await csms.changeAvailability(chargeBoxId, { connectorId, type });
    const nextStatus = (result && result.status === 'Accepted') ? 'accepted' : 'sent';

    await sb.from('commands')
      .update({ status: nextStatus, response: result ?? {}, updated_at: new Date().toISOString() })
      .eq('id', commandId);

    return res.status(202).json({
      commandId,
      status: nextStatus,
      ...(force ? { idempotentDuplicate: true, resent: true } : {}),
      response: result ?? {},
    });
  } catch (e:any) {
    await sb.from('commands')
      .update({ status:'pending', updated_at: new Date().toISOString() })
      .eq('id', commandId!);
    return res.status(409).json({
      commandId,
      status:'pending',
      ...(force ? { idempotentDuplicate: true } : {}),
      error:'charge_point_offline',
      detail: e?.message || 'charge_point_offline',
    });
  }
});


/* ===== Consultas ===== */
router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const r = await sb
    .from('commands')
    .select('id, command_type, transaction_id, charge_box_id, status, payload, response, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();

  if (r.error?.code === 'PGRST116') return res.status(404).json({ error: 'not_found' });
  if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });
  if (!r.data) return res.status(404).json({ error: 'not_found' });

  return res.json(r.data);
});

router.get('/', async (_req: Request, res: Response) => {
  const r = await sb
    .from('commands')
    .select('id, command_type, transaction_id, charge_box_id, status, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (r.error) return res.status(500).json({ error: 'query_error', detail: r.error.message });
  return res.json(r.data);
});

/* ===== GetConfiguration ===== */
const GetConfigurationSchema = z.object({
  chargeBoxId: z.string().min(1),
  key: z.array(z.string()).optional()
});

router.post('/getConfiguration', async (req: Request, res: Response) => {
  const parsed = GetConfigurationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
    });
  }
  const { chargeBoxId, key } = parsed.data;

  // registra comando
  const ins = await sb.from('commands').insert({
    command_type: 'GetConfiguration',
    charge_box_id: chargeBoxId,
    status: 'pending',
    requested_by: 'api',
    payload: { key }
  }).select('id').single();
  if (ins.error) return res.status(500).json({ error:'insert_error', detail: ins.error.message });

  const cmdId = ins.data.id;

  try {
    // Simular resposta de configuração (em um sistema real, isso viria do CSMS)
    const mockConfiguration = {
      configurationKey: [
        { key: 'HeartbeatInterval', readonly: false, value: '300' },
        { key: 'MeterValueSampleInterval', readonly: false, value: '60' },
        { key: 'ClockAlignedDataInterval', readonly: false, value: '900' },
        { key: 'ConnectionTimeOut', readonly: false, value: '60' },
        { key: 'GetConfigurationMaxKeys', readonly: true, value: '50' },
        { key: 'LocalAuthorizeOffline', readonly: false, value: 'true' },
        { key: 'LocalPreAuthorize', readonly: false, value: 'false' }
      ],
      unknownKey: []
    };

    await sb.from('commands').update({
      status: 'accepted',
      response: mockConfiguration,
      updated_at: new Date().toISOString()
    }).eq('id', cmdId);

    return res.status(200).json({ 
      commandId: cmdId, 
      status: 'accepted', 
      response: mockConfiguration 
    });
  } catch (e: any) {
    const msg = String(e?.message || '');
    await sb.from('commands').update({
      status: 'failed',
      response: { error: msg },
      updated_at: new Date().toISOString()
    }).eq('id', cmdId);

    return res.status(500).json({ error: 'get_configuration_failed', detail: msg });
  }
});

/* ===== GetDiagnostics ===== */
const GetDiagnosticsSchema = z.object({
  chargeBoxId: z.string().min(1),
  location: z.string().url(),
  retries: z.number().int().nonnegative().optional(),
  retryInterval: z.number().int().positive().optional(),
  startTime: z.string().datetime().optional(),
  stopTime: z.string().datetime().optional()
});

router.post('/getDiagnostics', async (req: Request, res: Response) => {
  const parsed = GetDiagnosticsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_payload',
      details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
    });
  }
  const { chargeBoxId, location, retries, retryInterval, startTime, stopTime } = parsed.data;

  // registra comando
  const ins = await sb.from('commands').insert({
    command_type: 'GetDiagnostics',
    charge_box_id: chargeBoxId,
    status: 'pending',
    requested_by: 'api',
    payload: { location, retries, retryInterval, startTime, stopTime }
  }).select('id').single();
  if (ins.error) return res.status(500).json({ error:'insert_error', detail: ins.error.message });

  const cmdId = ins.data.id;

  try {
    // Simular resposta de diagnósticos (em um sistema real, isso viria do CSMS)
    const mockDiagnostics = {
      fileName: `diagnostics_${chargeBoxId}_${new Date().toISOString().split('T')[0]}.log`,
      status: 'Accepted'
    };

    await sb.from('commands').update({
      status: 'accepted',
      response: mockDiagnostics,
      updated_at: new Date().toISOString()
    }).eq('id', cmdId);

    return res.status(200).json({ 
      commandId: cmdId, 
      status: 'accepted', 
      response: mockDiagnostics 
    });
  } catch (e: any) {
    const msg = String(e?.message || '');
    await sb.from('commands').update({
      status: 'failed',
      response: { error: msg },
      updated_at: new Date().toISOString()
    }).eq('id', cmdId);

    return res.status(500).json({ error: 'get_diagnostics_failed', detail: msg });
  }
});

export default router;
