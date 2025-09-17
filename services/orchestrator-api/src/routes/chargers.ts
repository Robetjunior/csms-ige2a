// src/routes/chargers.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';
import { csms } from '../ocpp/csms';

const router = Router();

const QuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(1000).default(10),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const haversineKm = (lat1:number, lon1:number, lat2:number, lon2:number) => {
  const toRad = (x:number)=>x*Math.PI/180;
  const R = 6371;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
};

router.get('/online', (_req, res) => {
  const peers = csms.listOnline();
  res.json(peers.map(id => ({ chargeBoxId: id, online: true })));
});


router.get('/:chargeBoxId', async (req, res) => {
  const id = String(req.params.chargeBoxId).trim();
  if (!id) return res.status(400).json({ error: 'invalid_charge_box_id' });

  // base do posto
  const cb = await sb.from('charge_boxes')
    .select('charge_box_id, site, lat, lon, address')
    .eq('charge_box_id', id).single();
  if (cb.error?.code === 'PGRST116') return res.status(404).json({ error:'not_found' });
  if (cb.error) return res.status(500).json({ error:'query_error', detail: cb.error.message });

  // conectores
  const connectors = await sb.from('connectors')
    .select('connector_id, type, power_kw')
    .eq('charge_box_id', id);
  if (connectors.error) return res.status(500).json({ error:'query_error', detail: connectors.error.message });

  // status OCPP atual por conector = último StatusNotification
  const st = await sb.rpc('last_status_by_connector', { p_charge_box_id: id }); // crie esta RPC (ver notas abaixo)

  // sessão ativa por conector (para “Occupied”)
  const active = await sb.from('sessions')
    .select('connector_id, transaction_id')
    .eq('charge_box_id', id).is('stopped_at', null);

  const occupied = new Set((active.data||[]).map(s => s.connector_id));
  const byStatus: Record<number, any> = {};
  (st.data||[]).forEach((r:any) => { byStatus[Number(r.connector_id)] = { status: r.status, at: r.created_at }; });

  // tarifa resolvida (modo ANY p/ card resumido; detalhe pode resolver por AC/DC)
  const tariff = await sb.rpc('resolve_tariff', { p_charge_box_id: id, p_mode: 'ANY', p_at: new Date().toISOString() });

  return res.json({
    ...cb.data,
    connectors: (connectors.data||[]).map((c:any) => ({
      connectorId: Number(c.connector_id),
      type: c.type, powerKw: c.power_kw != null ? Number(c.power_kw) : null,
      ocppStatus: byStatus[c.connector_id]?.status ?? (occupied.has(c.connector_id) ? 'Occupied' : 'Available'),
      occupied: occupied.has(c.connector_id),
      lastStatusAt: byStatus[c.connector_id]?.at ?? null,
    })),
    tariff: tariff.data?.[0] ?? null
  });
});

router.get('/', async (req: Request, res: Response) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error:'invalid_query', details: parsed.error.issues });
  const { lat, lon, radiusKm, limit } = parsed.data;

  try {
    // 1) Trazer charge boxes dentro de um "bounding box" simples (reduz carga)
    const latDeg = radiusKm / 110.574;
    const lonDeg = radiusKm / (111.320 * Math.cos(lat * Math.PI/180));
    const minLat = lat - latDeg, maxLat = lat + latDeg;
    const minLon = lon - lonDeg, maxLon = lon + lonDeg;

    const cb = await sb
      .from('charge_boxes')
      .select('charge_box_id, site, lat, lon')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lon', minLon).lte('lon', maxLon);

    if (cb.error) return res.status(500).json({ error:'query_error', detail: cb.error.message });

    const base = (cb.data || []).map((c:any) => ({
      chargeBoxId: c.charge_box_id,
      site: c.site,
      coords: { lat: Number(c.lat), lon: Number(c.lon) },
      distanceKm: haversineKm(lat, lon, Number(c.lat), Number(c.lon)),
    }))
    // filtrar pelo raio exato e ordenar por distância
    .filter(c => c.distanceKm <= radiusKm)
    .sort((a,b)=>a.distanceKm-b.distanceKm)
    .slice(0, limit);

    if (!base.length) return res.json([]);

    // 2) Conectores desses charge boxes
    const ids = base.map(b => b.chargeBoxId);
    const connectors = await sb
      .from('connectors')
      .select('charge_box_id, connector_id, type, power_kw')
      .in('charge_box_id', ids);

    if (connectors.error) return res.status(500).json({ error:'query_error', detail: connectors.error.message });

    // 3) Sessões ativas para marcar Occupied
    const act = await sb
      .from('sessions')
      .select('charge_box_id, connector_id, stopped_at')
      .is('stopped_at', null)
      .in('charge_box_id', ids);

    if (act.error) return res.status(500).json({ error:'query_error', detail: act.error.message });

    const occupied = new Set<string>();
    (act.data || []).forEach((s:any) => {
      if (s.connector_id != null) {
        occupied.add(`${s.charge_box_id}#${s.connector_id}`);
      }
    });

    // 4) Montar resposta
    const byCb: Record<string, any[]> = {};
    (connectors.data || []).forEach((r:any) => {
      const key = `${r.charge_box_id}#${r.connector_id}`;
      const status = occupied.has(key) ? 'Occupied' : 'Available';
      (byCb[r.charge_box_id] ||= []).push({
        connectorId: Number(r.connector_id),
        type: r.type ?? null,
        powerKw: r.power_kw != null ? Number(r.power_kw) : null,
        status
      });
    });

    const out = base.map(b => ({
      chargeBoxId: b.chargeBoxId,
      site: b.site,
      coords: b.coords,
      distanceKm: Number(b.distanceKm.toFixed(3)),
      connectors: (byCb[b.chargeBoxId] || []),
    }));

    return res.json(out);
  } catch (err:any) {
    console.error('[GET /v1/chargers] error:', err);
    return res.status(500).json({ error:'internal_error' });
  }
});

export default router;
