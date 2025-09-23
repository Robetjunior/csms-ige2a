// src/routes/chargers.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';
import { csms } from '../ocpp/csms';

const router = Router();

/* ============================ Schemas ============================ */

const ListQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(1000).default(20),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const OnlineQuery = z.object({
  sinceMinutes: z.coerce.number().int().positive().max(120).default(7),
  limit: z.coerce.number().int().positive().max(500).default(200),
});


/* ============================ Helpers ============================ */

const toISO = (d: Date) => d.toISOString();

const haversineKm = (lat1:number, lon1:number, lat2:number, lon2:number) => {
  const toRad = (x:number)=>x*Math.PI/180;
  const R = 6371;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
};

const isOccupiedStatus = (s:string|undefined) =>
  ['Preparing','Charging','SuspendedEVSE','SuspendedEV','Finishing','Reserved','Occupied'].includes(String(s || ''));


/* ============================ Rotas ============================ */

/**
 * GET /v1/chargers/online?sinceMinutes=7&limit=200
 * Consolida "online" via WS do CSMS + último Heartbeat recente.
 * Devolve também último status conhecido.
 */
router.get('/online', async (req: Request, res: Response) => {
  const q = OnlineQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', details: q.error.issues });
  const { sinceMinutes, limit } = q.data;

  const cutoffIso = toISO(new Date(Date.now() - sinceMinutes * 60_000));

  // 1) Heartbeats recentes
  const hb = await sb
    .from('last_heartbeat_v')
    .select('charge_box_id,last_heartbeat_at')
    .gte('last_heartbeat_at', cutoffIso);
  if (hb.error) return res.status(500).json({ error:'query_error', detail: hb.error.message });

  const onlineByHb = new Set((hb.data ?? []).map(r => r.charge_box_id));

  // 2) Conectados via nosso CSMS (WebSocket)
  const onlineByWs = new Set(csms.listOnline());

  // 3) União (limite)
  const union = Array.from(new Set<string>([...onlineByWs, ...onlineByHb])).slice(0, limit);
  if (union.length === 0) return res.json({ items: [], count: 0 });

  // 4) Último status de cada CP
  const st = await sb
    .from('last_status_v')
    .select('charge_box_id,status,last_status_at')
    .in('charge_box_id', union);
  if (st.error) return res.status(500).json({ error:'query_error', detail: st.error.message });

  const byStatus = new Map(st.data?.map(r => [r.charge_box_id, r]) ?? []);

  // 5) Monta resposta com snapshot do CSMS
  const items = union
    .map(id => {
      const snap = csms.getStatusSnapshot(id);
      const srow = byStatus.get(id);
      const hbRow = (hb.data ?? []).find(x => x.charge_box_id === id);
      return {
        chargeBoxId: id,
        wsOnline: snap.online || onlineByWs.has(id),
        onlineRecently: onlineByHb.has(id),
        lastHeartbeatAt: snap.lastHeartbeat ?? hbRow?.last_heartbeat_at ?? null,
        lastStatus: srow?.status ?? 'Unknown',
        lastStatusAt: srow?.last_status_at ?? null,
        connectors: snap.connectors,
        lastTransactionId: snap.lastTransactionId,
      };
    })
    .sort((a, b) => a.chargeBoxId.localeCompare(b.chargeBoxId));

  return res.json({ items, count: items.length });
});


/**
 * GET /v1/chargers/:chargeBoxId
 * Detalhe de um CP: dados cadastrais, conectores, status por conector, online, sessão ativa, etc.
 */
router.get('/:chargeBoxId', async (req: Request, res: Response) => {
  const id = String(req.params.chargeBoxId || '').trim();
  if (!id) return res.status(400).json({ error: 'invalid_charge_box_id' });

  // Base de localização
  const cb = await sb
    .from('charge_boxes_v')
    .select('charge_box_id, site, lat, lon, address')
    .eq('charge_box_id', id)
    .maybeSingle();

  if (cb.error) return res.status(500).json({ error:'query_error', detail: cb.error.message });

  // Snapshot em memória (por conector)
  const snap = csms.getStatusSnapshot(id);

  // Opcional: último status por CP (para fallback de "headline")
  const st = await sb
    .from('last_status_v')
    .select('status,last_status_at')
    .eq('charge_box_id', id)
    .maybeSingle();

  if (st.error && st.error.code !== 'PGRST116') {
    return res.status(500).json({ error:'query_error', detail: st.error.message });
  }

  return res.json({
    chargeBoxId: id,
    site: cb.data?.site ?? null,
    lat: cb.data?.lat ?? null,
    lon: cb.data?.lon ?? null,
    address: cb.data?.address ?? null,
    wsOnline: snap.online,
    lastHeartbeatAt: snap.lastHeartbeat ?? null,
    lastStatus: st.data?.status ?? (snap.connectors?.[0]?.status ?? 'Unknown'),
    lastStatusAt: st.data?.last_status_at ?? null,
    connectors: snap.connectors ?? [],
    lastTransactionId: snap.lastTransactionId ?? null,
  });
});

/**
 * GET /v1/chargers?lat=…&lon=…&radiusKm=10&limit=20&sinceMinutes=7&onlyOnline=true
 * Busca geográfica com status + online (WS/HB) e resumo dos conectores.
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error:'invalid_query', details: parsed.error.issues });
  const { lat, lon, radiusKm, limit } = parsed.data;

  try {
    /* 1) bounding box simples */
    const latDeg = radiusKm / 110.574;
    const lonDeg = radiusKm / (111.320 * Math.cos(lat * Math.PI/180));
    const minLat = lat - latDeg, maxLat = lat + latDeg;
    const minLon = lon - lonDeg, maxLon = lon + lonDeg;

    const cb = await sb
      .from('charge_boxes_v')
      .select('charge_box_id, site, lat, lon')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lon', minLon).lte('lon', maxLon);

    if (cb.error) return res.status(500).json({ error:'query_error', detail: cb.error.message });

    // Base com coords válidas (para distância)
    const baseWithCoords = (cb.data || [])
      .filter((r:any) => r.lat != null && r.lon != null)
      .map((c:any) => ({
        chargeBoxId: c.charge_box_id,
        site: c.site ?? null,
        coords: { lat: Number(c.lat), lon: Number(c.lon) },
        distanceKm: haversineKm(lat, lon, Number(c.lat), Number(c.lon)),
        needsLocation: false,
      }))
      .filter(c => c.distanceKm <= radiusKm)
      .sort((a,b)=>a.distanceKm-b.distanceKm)
      .slice(0, limit);

    const listedIds = new Set(baseWithCoords.map(b => b.chargeBoxId));

    /* 2) fallback: incluir CPs online que não estão na view/raio */
    const hb = await sb.from('last_heartbeat_v').select('charge_box_id,last_heartbeat_at');
    if (hb.error) return res.status(500).json({ error:'query_error', detail: hb.error.message });

    const onlineIds = Array.from(new Set<string>([...csms.listOnline(), ...((hb.data||[]).map(r=>r.charge_box_id))]));
    const fallbackIds = onlineIds.filter(id => !listedIds.has(id));

    const fallback = fallbackIds.map(id => ({
      chargeBoxId: id,
      site: null,
      coords: null as any,
      distanceKm: null as number | null,
      needsLocation: true, // apareça no app mas sem distância (sem lat/lon)
    })).slice(0, Math.max(0, limit - baseWithCoords.length));

    const base = [...baseWithCoords, ...fallback];

    if (!base.length) return res.json([]);

    /* 3) montar conectores/status usando snapshot do CSMS */
    const out = base.map(b => {
      const snap = csms.getStatusSnapshot(b.chargeBoxId);
      // “ocupado” se qualquer conector não estiver Available
      const anyBusy = (snap.connectors || []).some(c => isOccupiedStatus(c.status));
      return {
        chargeBoxId: b.chargeBoxId,
        site: b.site,
        coords: b.coords, // pode ser null no fallback
        distanceKm: b.distanceKm != null ? Number(b.distanceKm.toFixed(3)) : null,
        needsLocation: b.needsLocation,
        connectors: snap.connectors ?? [],
        overallStatus: anyBusy ? 'Occupied' : ((snap.connectors?.length ? 'Available' : 'Unknown')),
        wsOnline: snap.online,
        lastHeartbeatAt: snap.lastHeartbeat ?? null,
      };
    });

    return res.json(out);
  } catch (err:any) {
    console.error('[GET /v1/chargers] error:', err);
    return res.status(500).json({ error:'internal_error', detail: String(err?.message || err) });
  }
});

export default router;