// src/routes/ocpp-debug.ts
import { Router, Request, Response } from 'express';
import { csms } from '../ocpp/csms';

const r = Router();

// Lista CPs online (pelo registro em memória)
r.get('/online', (_req: Request, res: Response) => {
  try {
    const ids = csms.listOnline();
    const fmt = String((_req.query as any)?.format || '').toLowerCase();
    if (fmt === 'array' || fmt === 'list') return res.json(ids);
    return res.json({ online: ids });
  } catch (e: any) {
    return res.status(500).json({ error: 'internal_error', detail: e?.message || String(e) });
  }
});

// Snapshot resumido de um CP (último heartbeat e status dos conectores)
r.get('/:cbid/snapshot', (req: Request, res: Response) => {
  const { cbid } = req.params;
  const snap = csms.getStatusSnapshot(cbid);
  const hb = csms.getLastHeartbeat(cbid);
  if (!snap && !hb) return res.status(404).json({ error: 'not_found_or_offline' });
  const online = !!(snap && (snap as any).online === true);
  const connectors = snap?.connectors ?? [];
  res.json({ chargeBoxId: cbid, online, lastHeartbeat: hb ?? null, connectors, snapshot: snap ?? null });
});

// (Opcional) Mapeamento de transactionId -> CP
r.get('/tx-bindings', (_req: Request, res: Response) => {
  res.json({ bindings: csms.listTxBindings() });
});

export default r;
