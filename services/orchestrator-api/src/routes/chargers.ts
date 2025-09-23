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

const isSchemaCacheErr = (e: any) => {
  const msg = (e?.message || e?.details || e?.hint || '').toString().toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist') || e?.code === '42P01';
};


/* ---------- Fallbacks quando a VIEW ainda não está no cache ---------- */
async function fetchLastHeartbeats(cutoffIso: string) {
  const v = await sb
    .from('last_heartbeat_v')
    .select('charge_box_id,last_heartbeat_at')
    .gte('last_heartbeat_at', cutoffIso);

  if (!v.error && v.data) {
    const map = new Map<string, string>();
    for (const r of v.data as any[]) map.set(r.charge_box_id, r.last_heartbeat_at);
    return map;
  }
  if (!isSchemaCacheErr(v.error)) throw new Error(v.error?.message || 'hb query error');

  // Fallback: tenta ocpp_events -> events
  for (const table of ['ocpp_events','events']) {
    const e = await sb
      .from(table as any)
      .select('charge_box_id,created_at')
      .eq('event_type', 'Heartbeat')
      .order('created_at', { ascending: false })
      .limit(5000);

    if (!e.error && e.data) {
      const map = new Map<string, string>();
      for (const r of e.data as any[]) {
        if (!map.has(r.charge_box_id) && (!cutoffIso || r.created_at >= cutoffIso)) {
          map.set(r.charge_box_id, r.created_at);
        }
      }
      return map;
    }
  }

  // Nada encontrado
  return new Map<string, string>();
}

async function fetchLastStatuses(ids: string[]) {
  const out = new Map<string, { status: string; last_status_at: string }>();
  if (ids.length === 0) return out;

  const v = await sb
    .from('last_status_v')
    .select('charge_box_id,status,last_status_at')
    .in('charge_box_id', ids);

  if (!v.error && v.data) {
    for (const r of v.data as any[]) out.set(r.charge_box_id, { status: r.status, last_status_at: r.last_status_at });
    return out;
  }
  if (!isSchemaCacheErr(v.error)) throw new Error(v.error?.message || 'status query error');

  // Fallback: tenta ocpp_events -> events
  for (const table of ['ocpp_events','events']) {
    const e = await sb
      .from(table as any)
      .select('charge_box_id,created_at,payload')
      .eq('event_type', 'StatusNotification')
      .in('charge_box_id', ids)
      .order('created_at', { ascending: false })
      .limit(ids.length * 10);

    if (!e.error && e.data) {
      for (const r of e.data as any[]) {
        if (!out.has(r.charge_box_id)) {
          const st = r?.payload?.status ?? 'Unknown';
          out.set(r.charge_box_id, { status: st, last_status_at: r.created_at });
        }
      }
      return out;
    }
  }

  return out;
}

/* ============================ Rotas ============================ */

/** GET /v1/chargers/online */
router.get('/online', async (req: Request, res: Response) => {
  const q = OnlineQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', details: q.error.issues });
  const { sinceMinutes, limit } = q.data;

  try {
    const cutoffIso = toISO(new Date(Date.now() - sinceMinutes * 60_000));

    const hbMap = await fetchLastHeartbeats(cutoffIso);
    const onlineByWs = new Set(csms.listOnline());
    const onlineByHb = new Set(hbMap.keys());

    const union = Array.from(
      new Set<string>([
        ...Array.from(onlineByWs),
        ...Array.from(onlineByHb),
      ])
    ).slice(0, limit);

    const stMap = await fetchLastStatuses(union);

    const items = union
      .map((id) => {
        const snap = csms.getStatusSnapshot(id);
        const srow = stMap.get(id);
        return {
          chargeBoxId: id,
          wsOnline: snap.online || onlineByWs.has(id),
          onlineRecently: onlineByHb.has(id),
          lastHeartbeatAt: snap.lastHeartbeat ?? hbMap.get(id) ?? null,
          lastStatus: srow?.status ?? 'Unknown',
          lastStatusAt: srow?.last_status_at ?? null,
          connectors: snap.connectors,
          lastTransactionId: snap.lastTransactionId,
        };
      })
      .sort((a, b) => a.chargeBoxId.localeCompare(b.chargeBoxId));

    return res.json({ items, count: items.length });
  } catch (err: any) {
    console.error('[GET /v1/chargers/online] error:', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
  }
});

/** GET /v1/chargers/:chargeBoxId */
router.get('/:chargeBoxId', async (req: Request, res: Response) => {
  const id = String(req.params.chargeBoxId || '').trim();
  if (!id) return res.status(400).json({ error: 'invalid_charge_box_id' });

  try {
    const cb = await sb
      .from('charge_boxes_v')
      .select('charge_box_id, site, lat, lon, address')
      .eq('charge_box_id', id)
      .maybeSingle();

    if (cb.error && !isSchemaCacheErr(cb.error)) {
      return res.status(500).json({ error: 'query_error', detail: cb.error.message });
    }

    const snap = csms.getStatusSnapshot(id);
    const stMap = await fetchLastStatuses([id]);
    const srow = stMap.get(id);

    return res.json({
      chargeBoxId: id,
      site: cb.data?.site ?? null,
      lat: cb.data?.lat ?? null,
      lon: cb.data?.lon ?? null,
      address: cb.data?.address ?? null,
      wsOnline: snap.online,
      lastHeartbeatAt: snap.lastHeartbeat ?? null,
      lastStatus: srow?.status ?? (snap.connectors?.[0]?.status ?? 'Unknown'),
      lastStatusAt: srow?.last_status_at ?? null,
      connectors: snap.connectors ?? [],
      lastTransactionId: snap.lastTransactionId ?? null,
    });
  } catch (err: any) {
    console.error('[GET /v1/chargers/:id] error:', err?.message || err);
    return res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
  }
});

/** GET /v1/chargers?lat=…&lon=…&radiusKm=… */
router.get('/', async (req: Request, res: Response) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error:'invalid_query', details: parsed.error.issues });
  const { lat, lon, radiusKm, limit } = parsed.data;

  try {
    const latDeg = radiusKm / 110.574;
    const lonDeg = radiusKm / (111.320 * Math.cos(lat * Math.PI/180));
    const minLat = lat - latDeg, maxLat = lat + latDeg;
    const minLon = lon - lonDeg, maxLon = lon + lonDeg;

    let cb: any = await sb
      .from('charge_boxes_v')
      .select('charge_box_id, site, lat, lon')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lon', minLon).lte('lon', maxLon);

    if (cb.error && isSchemaCacheErr(cb.error)) {
      cb = await sb.from('charge_boxes').select('charge_box_id, site, lat, lon');
    } else if (cb.error) {
      return res.status(500).json({ error:'query_error', detail: cb.error.message });
    }

    const baseWithCoords = (cb.data || [])
      .filter((r:any) => r.lat != null && r.lon != null)
      .map((c:any) => ({
        chargeBoxId: c.charge_box_id,
        site: c.site ?? null,
        coords: { lat: Number(c.lat), lon: Number(c.lon) },
        distanceKm: haversineKm(lat, lon, Number(c.lat), Number(c.lon)),
        needsLocation: false,
      }))
      .filter((c: { distanceKm: number; }) => c.distanceKm <= radiusKm)
      .sort((a: { distanceKm: number; },b: { distanceKm: number; })=>a.distanceKm-b.distanceKm)
      .slice(0, limit);

    const listedIds = new Set(baseWithCoords.map((b: { chargeBoxId: any; }) => b.chargeBoxId));

    const hbMap = await fetchLastHeartbeats(toISO(new Date(0)));
    const onlineIds = Array.from(new Set<string>([
      ...csms.listOnline(),
      ...Array.from(hbMap.keys())
    ]));
    const fallbackIds = onlineIds.filter(id => !listedIds.has(id));

    const fallback = fallbackIds.map(id => ({
      chargeBoxId: id,
      site: null,
      coords: null as any,
      distanceKm: null as number | null,
      needsLocation: true,
    })).slice(0, Math.max(0, limit - baseWithCoords.length));

    const base = [...baseWithCoords, ...fallback];
    if (!base.length) return res.json([]);

    const out = base.map(b => {
      const snap = csms.getStatusSnapshot(b.chargeBoxId);
      const anyBusy = (snap.connectors || []).some(c => isOccupiedStatus(c.status));
      return {
        chargeBoxId: b.chargeBoxId,
        site: b.site,
        coords: b.coords,
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
    console.error('[GET /v1/chargers] error:', err?.message || err);
    return res.status(500).json({ error:'internal_error', detail: String(err?.message || err) });
  }
});

export default router;
