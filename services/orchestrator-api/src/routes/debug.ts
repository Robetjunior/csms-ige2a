import { Router, Request, Response } from 'express';
import { csms } from '../ocpp/csms';
import { sb } from '../../supabase';

const router = Router();

router.get('/ocpp/online', (_req: Request, res: Response) => {
  try { return res.json({ online: csms.listOnline() }); }
  catch (e:any) { return res.status(500).json({ error:'internal_error', detail: e?.message||String(e) }); }
});

router.get('/ocpp/resolve-tx/:tx', (req: Request, res: Response) => {
  const tx = Number(req.params.tx);
  if (!Number.isFinite(tx) || tx <= 0) return res.status(400).json({ error:'invalid_tx' });
  try {
    const chargeBoxId = csms.resolveTx(tx);
    if (!chargeBoxId) return res.status(404).json({ found:false, tx, chargeBoxId:null });
    return res.json({ found:true, tx, chargeBoxId });
  } catch (e:any) {
    return res.status(500).json({ error:'internal_error', detail: e?.message||String(e) });
  }
});

router.get('/ocpp/bindings', (_req: Request, res: Response) => {
  try { return res.json({ bindings: csms.listTxBindings() }); }
  catch (e:any) { return res.status(500).json({ error:'internal_error', detail: e?.message||String(e) }); }
});

router.get('/ocpp/last-tx/:cbid', (req: Request, res: Response) => {
  const cbid = String(req.params.cbid);
  try {
    const tx = csms.getLastTxForChargeBox(cbid);
    if (!tx) return res.status(404).json({ found:false, chargeBoxId: cbid, transactionId: null });
    return res.json({ found:true, chargeBoxId: cbid, transactionId: tx });
  } catch (e:any) {
    return res.status(500).json({ error:'internal_error', detail: e?.message||String(e) });
  }
});

router.get('/ocpp/status/:cbid', (req: Request, res: Response) => {
  const cbid = String(req.params.cbid);
  try {
    const online = csms.listOnline().includes(cbid);
    const connectors = csms.getConnectorStatuses(cbid);
    const lastHeartbeat = csms.getLastHeartbeat(cbid) ?? null;
    return res.json({ chargeBoxId: cbid, online, lastHeartbeat, connectors });
  } catch (e:any) {
    return res.status(500).json({ error:'internal_error', detail: e?.message || String(e) });
  }
});

router.get('/ocpp/commands-for-tx/:tx', async (req: Request, res: Response) => {
  const tx = Number(req.params.tx);
  if (!Number.isFinite(tx) || tx <= 0) return res.status(400).json({ error:'invalid_tx' });
  try {
    const r = await sb
      .from('commands')
      .select('id,command_type,transaction_id,charge_box_id,status,created_at,updated_at')
      .eq('transaction_id', tx)
      .order('id', { ascending: true });
    if (r.error) return res.status(500).json({ error:'query_error', detail: r.error.message });
    return res.json({ items: r.data });
  } catch (e:any) {
    return res.status(500).json({ error:'internal_error', detail: e?.message || String(e) });
  }
});

export default router;
