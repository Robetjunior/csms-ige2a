import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';

const router = Router();

/**
 * GET /v1/chargers/:chargeBoxId
 * Retorna dados do site + conectores + último status OCPP + “em sessão?”
 */
router.get('/:chargeBoxId', async (req: Request, res: Response) => {
  const chargeBoxId = String(req.params.chargeBoxId || '').trim();
  if (!chargeBoxId) return res.status(400).json({ error: 'invalid_charge_box_id' });

  // Carregador
  const cb = await sb
    .from('charge_boxes')
    .select('charge_box_id, site, lat, lon, address, capabilities')
    .eq('charge_box_id', chargeBoxId)
    .single();
  if (cb.error?.code === 'PGRST116') return res.status(404).json({ error: 'not_found' });
  if (cb.error) return res.status(500).json({ error: 'query_error', detail: cb.error.message });

  // Conectores + status
  const cons = await sb
    .from('connectors')
    .select('connector_id, type, power_kw, last_status, last_status_at, error_code')
    .eq('charge_box_id', chargeBoxId)
    .order('connector_id', { ascending: true });
  if (cons.error) return res.status(500).json({ error: 'query_error', detail: cons.error.message });

  // Sessões ativas para marcar "em uso"
  const act = await sb
    .from('sessions')
    .select('connector_id')
    .eq('charge_box_id', chargeBoxId)
    .is('stopped_at', null);
  const inUse = new Set((act.data || []).map(r => r.connector_id));

  const connectors = (cons.data || []).map((c: any) => ({
    connectorId: Number(c.connector_id),
    type: c.type ?? null,
    powerKw: c.power_kw != null ? Number(c.power_kw) : null,
    ocppStatus: c.last_status ?? null,                // Charging/Preparing/Reserved/Unavailable/Faulted/Available...
    ocppStatusAt: c.last_status_at ?? null,
    errorCode: c.error_code ?? null,
    inUse: inUse.has(c.connector_id),                 // redundância útil p/ UI
  }));

  return res.json({
    chargeBoxId: cb.data?.charge_box_id,
    site: cb.data?.site,
    address: cb.data?.address ?? null,
    coords: { lat: cb.data?.lat, lon: cb.data?.lon },
    capabilities: cb.data?.capabilities ?? null,
    connectors,
  });
});

export default router;
