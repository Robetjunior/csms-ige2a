// src/routes/chargers.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sb } from '../../supabase';
import { csms } from '../ocpp/csms';

const router = Router();

/* ============================ Schemas ============================ */

const NearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(1000).default(10),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sinceMinutes: z.coerce.number().int().positive().max(120).default(7),
  onlyOnline: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional()
    .transform(v => (v ? v === '1' || v === 'true' : false)),
});

const OnlineQuery = z.object({
  sinceMinutes: z.coerce.number().int().positive().max(120).default(7),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const IdParam = z.object({
  chargeBoxId: z.string().min(1),
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

// Agrupa eventos de StatusNotification por conector e pega o mais recente
function reduceLastStatusByConnector(rows: any[]) {
  const out = new Map<number, { status: string; created_at: string }>();
  for (const r of rows || []) {
    const cid = Number(r.payload?.connectorId ?? r.connector_id ?? 0);
    const cur = out.get(cid);
    if (!cur || new Date(r.created_at).getTime() > new Date(cur.created_at).getTime()) {
      out.set(cid, {
        status: String(r.payload?.status ?? r.status ?? 'Unknown'),
        created_at: r.created_at,
      });
    }
  }
  return out;
}

/* ============================ Rotas ============================ */

/**
 * GET /v1/chargers/online?sinceMinutes=7&limit=200
 * Consolida "online" via WS do CSMS + último Heartbeat recente.
 * Devolve também último status conhecido.
 */
router.get('/online', async (req: Request, res: Response) => {
  const sinceMinutes = Number(req.query.sinceMinutes ?? 10);
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const cutoffIso = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  // 1) Online via WebSocket (registry do CSMS)
  const onlineByWs = new Set(csms.listOnline());

  // 2) Heartbeats recentes direto de events (plano B sem view)
  let onlineByHb = new Set<string>();
  const lastHbByCb = new Map<string, string>();

  const hb = await sb
    .from('events')
    .select('charge_box_id, created_at')
    .eq('event_type', 'Heartbeat')
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: false })
    .limit(2000); // guarda- chuva

  if (!hb.error && hb.data) {
    for (const r of hb.data as any[]) {
      const id = r.charge_box_id as string;
      if (!lastHbByCb.has(id)) {
        lastHbByCb.set(id, r.created_at);
        onlineByHb.add(id);
      }
    }
  }

  // 3) União WS ∪ Heartbeat (corta no limit)
  const unionIds = Array.from(new Set<string>([...onlineByWs, ...onlineByHb])).slice(0, limit);

  // 4) Último StatusNotification por CP (plano B sem view)
  const lastStatusByCb = new Map<string, { status: string; at: string }>();
  if (unionIds.length) {
    const st = await sb
      .from('events')
      .select('charge_box_id, created_at, payload')
      .eq('event_type', 'StatusNotification')
      .in('charge_box_id', unionIds)
      .order('created_at', { ascending: false })
      .limit(2000);

    if (!st.error && st.data) {
      for (const r of st.data as any[]) {
        const id = r.charge_box_id as string;
        if (!lastStatusByCb.has(id)) {
          const status = r.payload?.status ?? 'Unknown';
          lastStatusByCb.set(id, { status, at: r.created_at });
        }
      }
    }
  }

  // 5) Monta resposta combinando com snapshot do CSMS (conectores/tx)
  const items = unionIds
    .map(id => {
      const snap = csms.getStatusSnapshot(id);
      const st = lastStatusByCb.get(id);
      const hbAt = snap.lastHeartbeat ?? lastHbByCb.get(id) ?? null;

      return {
        chargeBoxId: id,
        wsOnline: snap.online || onlineByWs.has(id),
        onlineRecently: onlineByHb.has(id),
        lastHeartbeatAt: hbAt,
        lastStatus: st?.status ?? 'Unknown',
        lastStatusAt: st?.at ?? null,
        connectors: snap.connectors,            // do registry (em RAM)
        lastTransactionId: snap.lastTransactionId,
      };
    })
    .sort((a, b) => a.chargeBoxId.localeCompare(b.chargeBoxId));

  return res.json({ items, count: items.length, sinceMinutes, limit });
});


/**
 * GET /v1/chargers/:chargeBoxId
 * Detalhe de um CP: dados cadastrais, conectores, status por conector, online, sessão ativa, etc.
 */
router.get('/:chargeBoxId', async (req: Request, res: Response) => {
  const p = IdParam.safeParse(req.params);
  if (!p.success) return res.status(400).json({ error: 'invalid_charge_box_id' });
  const id = p.data.chargeBoxId;

  // Cadastral
  const cb = await sb
    .from('charge_boxes')
    .select('charge_box_id,site,lat,lon,address')
    .eq('charge_box_id', id)
    .maybeSingle();

  if (cb.error?.code === 'PGRST116' || (!cb.data && !cb.error)) {
    // mesmo sem cadastral, devolve snapshot WS se existir
    const snap = csms.getStatusSnapshot(id);
    if (!snap.online) return res.status(404).json({ error: 'not_found' });
  }
  if (cb.error && cb.error.code !== 'PGRST116') {
    return res.status(500).json({ error: 'query_error', detail: cb.error.message });
  }

  // Conectores cadastrados
  const connectors = await sb
    .from('connectors')
    .select('connector_id,type,power_kw')
    .eq('charge_box_id', id);

  if (connectors.error) return res.status(500).json({ error:'query_error', detail: connectors.error.message });

  // Últimos StatusNotification (reduzidos no cliente) – limite razoável
  const st = await sb
    .from('events')
    .select('created_at,payload')
    .eq('charge_box_id', id)
    .eq('event_type', 'StatusNotification')
    .order('created_at', { ascending: false })
    .limit(400);

  if (st.error) return res.status(500).json({ error:'query_error', detail: st.error.message });
  const lastByConn = reduceLastStatusByConnector(st.data || []);

  // Sessões ativas
  const active = await sb
    .from('sessions')
    .select('connector_id,transaction_id')
    .eq('charge_box_id', id)
    .is('stopped_at', null);

  if (active.error) return res.status(500).json({ error:'query_error', detail: active.error.message });

  const occupied = new Map<number, number>();
  (active.data || []).forEach(s => { if (s.connector_id != null) occupied.set(Number(s.connector_id), Number(s.transaction_id)); });

  // Snapshot em memória
  const snap = csms.getStatusSnapshot(id);

  // Tarifa (opcional) – ignore erro se RPC não existir
  let tariff: any = null;
  try {
    const t = await sb.rpc('resolve_tariff', { p_charge_box_id: id, p_mode: 'ANY', p_at: new Date().toISOString() });
    if (!t.error) tariff = t.data?.[0] ?? null;
  } catch {}

  return res.json({
    chargeBoxId: id,
    site: cb.data?.site ?? null,
    coords: { lat: cb.data?.lat ?? null, lon: cb.data?.lon ?? null },
    address: cb.data?.address ?? null,
    wsOnline: snap.online,
    wsLastHeartbeatAt: snap.lastHeartbeat,
    lastTransactionId: snap.lastTransactionId,
    connectors: (connectors.data || []).map((c: any) => {
      const k = Number(c.connector_id);
      const last = lastByConn.get(k);
      const occTx = occupied.get(k);
      const ocppStatus = occTx ? 'Occupied' : (last?.status ?? 'Available');
      return {
        connectorId: k,
        type: c.type ?? null,
        powerKw: c.power_kw != null ? Number(c.power_kw) : null,
        ocppStatus,
        lastStatusAt: last?.created_at ?? null,
        activeTransactionId: occTx ?? null,
      };
    }),
    tariff,
  });
});

/**
 * GET /v1/chargers?lat=…&lon=…&radiusKm=10&limit=20&sinceMinutes=7&onlyOnline=true
 * Busca geográfica com status + online (WS/HB) e resumo dos conectores.
 */
router.get('/', async (req: Request, res: Response) => {
  const parsed = NearbyQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error:'invalid_query', details: parsed.error.issues });
  const { lat, lon, radiusKm, limit, sinceMinutes, onlyOnline } = parsed.data;

  try {
    // 1) bounding box
    const latDeg = radiusKm / 110.574;
    const lonDeg = radiusKm / (111.320 * Math.cos(lat * Math.PI/180));
    const minLat = lat - latDeg, maxLat = lat + latDeg;
    const minLon = lon - lonDeg, maxLon = lon + lonDeg;

    // 2) charge boxes candidatos
    const cb = await sb
      .from('charge_boxes')
      .select('charge_box_id,site,lat,lon')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lon', minLon).lte('lon', maxLon);

    if (cb.error) return res.status(500).json({ error:'query_error', detail: cb.error.message });

    const base = (cb.data || []).map((c:any) => ({
      chargeBoxId: c.charge_box_id,
      site: c.site,
      coords: { lat: Number(c.lat), lon: Number(c.lon) },
      distanceKm: haversineKm(lat, lon, Number(c.lat), Number(c.lon)),
    }))
      .filter(c => c.distanceKm <= radiusKm)
      .sort((a,b)=>a.distanceKm-b.distanceKm)
      .slice(0, limit);

    if (!base.length) return res.json([]);

    const ids = base.map(b => b.chargeBoxId);

    // 3) status/heartbeat consolidados via views
    const [sv, hv] = await Promise.all([
      sb.from('last_status_v').select('charge_box_id,status,last_status_at').in('charge_box_id', ids),
      sb.from('last_heartbeat_v').select('charge_box_id,last_heartbeat_at').in('charge_box_id', ids),
    ]);
    if (sv.error) return res.status(500).json({ error:'query_error', detail: sv.error.message });
    if (hv.error) return res.status(500).json({ error:'query_error', detail: hv.error.message });

    const byStatus = new Map(sv.data?.map(r => [r.charge_box_id, r]) ?? []);
    const byHb = new Map(hv.data?.map(r => [r.charge_box_id, r.last_heartbeat_at]) ?? []);
    const cutoff = Date.now() - sinceMinutes * 60_000;

    // 4) conectores + sessões ativas para resumo/occupied
    const [conns, act] = await Promise.all([
      sb.from('connectors').select('charge_box_id,connector_id,type,power_kw').in('charge_box_id', ids),
      sb.from('sessions').select('charge_box_id,connector_id').is('stopped_at', null).in('charge_box_id', ids),
    ]);
    if (conns.error) return res.status(500).json({ error:'query_error', detail: conns.error.message });
    if (act.error) return res.status(500).json({ error:'query_error', detail: act.error.message });

    const occupied = new Set<string>();
    (act.data || []).forEach((s:any) => {
      if (s.connector_id != null) occupied.add(`${s.charge_box_id}#${s.connector_id}`);
    });

    const cByCb: Record<string, any[]> = {};
    (conns.data || []).forEach((r:any) => {
      const id = r.charge_box_id;
      const key = `${id}#${r.connector_id}`;
      (cByCb[id] ||= []).push({
        connectorId: Number(r.connector_id),
        type: r.type ?? null,
        powerKw: r.power_kw != null ? Number(r.power_kw) : null,
        status: occupied.has(key) ? 'Occupied' : 'Available',
      });
    });

    // 5) WS snapshot
    const wsSet = new Set(csms.listOnline());

    const out = base
      .map(b => {
        const s = byStatus.get(b.chargeBoxId);
        const hb = byHb.get(b.chargeBoxId);
        const onlineRecently = hb ? new Date(hb).getTime() >= cutoff : false;
        const wsOnline = wsSet.has(b.chargeBoxId) || csms.getStatusSnapshot(b.chargeBoxId).online;

        return {
          chargeBoxId: b.chargeBoxId,
          site: b.site,
          coords: b.coords,
          distanceKm: Number(b.distanceKm.toFixed(3)),
          lastStatus: s?.status ?? 'Unknown',
          lastStatusAt: s?.last_status_at ?? null,
          lastHeartbeatAt: hb ?? null,
          onlineRecently,
          wsOnline,
          connectors: cByCb[b.chargeBoxId] || [],
        };
      })
      .filter(x => (onlyOnline ? (x.wsOnline || x.onlineRecently) : true))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return res.json(out);
  } catch (err:any) {
    console.error('[GET /v1/chargers] error:', err);
    return res.status(500).json({ error:'internal_error' });
  }
});

export default router;
