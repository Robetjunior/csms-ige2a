import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';
import { csms } from '../ocpp/csms';

const router = Router();
// Removido middleware redundante requireApiKey; já aplicado globalmente em /v1

/* helpers */
const num = (v:any, d?:number)=> (v==null||v==='') ? (d??null) : (Number.isFinite(Number(v))? Number(v): null);
const isValidLatLon = (lat:number|null, lon:number|null)=> lat!=null && lon!=null && lat>=-90 && lat<=90 && lon>=-180 && lon<=180;
const haversineKm = (a:number,b:number,c:number,d:number)=>{ const R=6371, toR=(x:number)=>x*Math.PI/180; const dLat=toR(c-a), dLon=toR(d-b); const s=Math.sin(dLat/2)**2+Math.cos(toR(a))*Math.cos(toR(c))*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.sqrt(s)); };
const timed = (label:string)=>{ const t0=Date.now(); return { t0, done:(extra?:any)=>console.log({route:label,duration_ms:Date.now()-t0,...(extra||{})}) }; };
const ok = (res:Response, data:any)=> res.json(data);
const err = (res:Response, code:number, error='internal_error', detail?:any)=> res.status(code).json({ error, detail });

// Add a short timeout for Supabase queries to avoid hanging responses
const qTimeoutMs = Number(process.env.SUPABASE_QUERY_TIMEOUT_MS ?? '1500');
async function withTimeout<T>(p: Promise<T>, ms = qTimeoutMs): Promise<T | null> {
  return await Promise.race([
    p,
    new Promise<T | null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/* GET /v1/chargers/online */
router.get('/online', async (req:Request, res:Response) => {
  const t = timed('chargers/online');
  const sinceMinutes = num(req.query.sinceMinutes, 7) ?? 7;
  const limit = num(req.query.limit, 200) ?? 200;
  try {
    // Optional fast-path: skip DB if explicitly disabled or unreachable
    const disableDb = (process.env.DISABLE_DB_ONLINE ?? '0') === '1';
    if (disableDb) {
      const ws = new Set(csms.listOnline());
      const ids = Array.from(ws).slice(0, limit);
      const items = ids.map(id => {
        const snap = csms.getStatusSnapshot(id);
        return {
          chargeBoxId: id,
          wsOnline: true,
          onlineRecently: snap.lastHeartbeat != null,
          lastHeartbeatAt: snap.lastHeartbeat ?? null,
          lastStatus: snap.connectors?.[0]?.status ?? 'Unknown',
          lastStatusAt: null,
          connectors: snap.connectors ?? [],
          lastTransactionId: snap.lastTransactionId ?? null,
        };
      });
      t.done({ count: items.length, fastPath: true });
      return ok(res, { items, count: items.length });
    }

    const cutoff = new Date(Date.now() - sinceMinutes*60_000).toISOString();
    const v: any = await withTimeout<any>(sb.from('last_heartbeat_v').select('charge_box_id,last_heartbeat_at').gte('last_heartbeat_at', cutoff));
    const hb = new Map<string,string>();
    if (v && !v.error && v.data) for (const r of v.data as any[]) hb.set(r.charge_box_id, r.last_heartbeat_at);
    else {
      const e: any = await withTimeout<any>(sb.from('ocpp_events').select('charge_box_id,created_at').eq('event_type','Heartbeat').gte('created_at', cutoff).limit(5000));
      if (e && !e.error && e.data) for (const r of e.data as any[]) hb.set(r.charge_box_id, r.created_at);
    }
    const ws = new Set(csms.listOnline());
    const ids = Array.from(new Set([...ws, ...hb.keys()])).slice(0, limit);
    const st: any = ids.length ? await withTimeout<any>(sb.from('last_status_v').select('charge_box_id,status,last_status_at').in('charge_box_id', ids)) : null;
    const status = new Map<string,{s:string,t:string|null}>();
    if (st && !st.error && st.data) for (const r of st.data as any[]) status.set(r.charge_box_id, { s:r.status, t:r.last_status_at });

    const items = ids.map(id=>{
      const snap = csms.getStatusSnapshot(id);
      const srow = status.get(id);
      return {
        chargeBoxId:id,
        wsOnline: snap.online || ws.has(id),
        onlineRecently: hb.has(id),
        lastHeartbeatAt: snap.lastHeartbeat ?? hb.get(id) ?? null,
        lastStatus: srow?.s ?? (snap.connectors?.[0]?.status ?? 'Unknown'),
        lastStatusAt: srow?.t ?? null,
        connectors: snap.connectors ?? [],
        lastTransactionId: snap.lastTransactionId ?? null,
      };
    });
    t.done({count:items.length});
    return ok(res, { items, count: items.length });
  } catch (e:any) {
    console.error('[online]', e?.message||e); return err(res,500);
  }
});

/* GET /v1/chargers/:chargeBoxId */
router.get('/:chargeBoxId', async (req:Request, res:Response)=>{
  const t = timed('chargers/:id');
  const id = String(req.params.chargeBoxId||'').trim();
  if (!id) return err(res,400,'invalid_charge_box_id');
  try {
    const cb: any = await withTimeout<any>(sb.from('charge_boxes_v').select('charge_box_id,site,lat,lon,address').eq('charge_box_id', id).maybeSingle());
    const snap = csms.getStatusSnapshot(id);
    t.done();
    const latVal = (cb?.data?.lat!=null && Number.isFinite(Number(cb.data.lat))) ? Number(cb.data.lat) : null;
    const lonVal = (cb?.data?.lon!=null && Number.isFinite(Number(cb.data.lon))) ? Number(cb.data.lon) : null;
    return ok(res, {
      chargeBoxId:id,
      site: cb?.data?.site ?? null,
      lat: latVal,
      lon: lonVal,
      address: cb?.data?.address ?? null,
      wsOnline: snap.online,
      lastHeartbeatAt: snap.lastHeartbeat ?? null,
      lastStatus: snap.connectors?.[0]?.status ?? 'Unknown',
      lastStatusAt: null,
      connectors: snap.connectors ?? [],
      lastTransactionId: snap.lastTransactionId ?? null,
    });
  } catch(e:any){ console.error('[get:id]',e?.message||e); return err(res,500); }
});

/* GET /v1/chargers?lat&lon&radiusKm&limit */
router.get('/', async (req:Request, res:Response)=>{
  const t = timed('chargers/list');
  const lat = num(req.query.lat), lon = num(req.query.lon);
  const radiusKm = num(req.query.radiusKm, 20) ?? 20;
  const limit = num(req.query.limit, 50) ?? 50;
  if (!isValidLatLon(lat, lon)) return err(res,400,'invalid_parameters');
  try {
    const latDeg = radiusKm/110.574;
    const lonDeg = radiusKm/(111.320*Math.cos((lat as number)*Math.PI/180));
    const minLat=(lat as number)-latDeg, maxLat=(lat as number)+latDeg;
    const minLon=(lon as number)-lonDeg, maxLon=(lon as number)+lonDeg;

    // Seleciona lat/lon e filtra por latitude no banco; longitude é filtrada no Node.
    const q: any = await withTimeout<any>(sb.from('charge_boxes_v')
      .select('charge_box_id,site,lat,lon')
      .gte('lat', minLat).lte('lat', maxLat));

    const base = (q?.data||[])
      .map((r:any)=>{
        const latNum = (r.lat!=null && Number.isFinite(Number(r.lat))) ? Number(r.lat) : null;
        const lonNum = (r.lon!=null && Number.isFinite(Number(r.lon))) ? Number(r.lon) : null;
        return { row:r, latNum, lonNum };
      })
      .filter(({latNum, lonNum}: any)=> latNum!=null && lonNum!=null && lonNum>=minLon && lonNum<=maxLon)
      .map(({row, latNum, lonNum}: any)=>({
        chargeBoxId: row.charge_box_id,
        site: row.site ?? null,
        coords: { lat: latNum as number, lon: lonNum as number },
        distanceKm: haversineKm(lat as number, lon as number, latNum as number, lonNum as number),
      }))
      .sort((a: any,b: any)=>a.distanceKm-b.distanceKm)
      .slice(0, limit)
      .map((b: any)=>{
        const snap = csms.getStatusSnapshot(b.chargeBoxId);
        const anyBusy = (snap.connectors||[]).some(c=>['Preparing','Charging','SuspendedEVSE','SuspendedEV','Finishing','Reserved','Occupied'].includes(String(c.status||'')));
        return {
          chargeBoxId:b.chargeBoxId,
          site:b.site,
          coords:b.coords,
          distanceKm:Number(b.distanceKm.toFixed(3)),
          overallStatus: anyBusy ? 'Occupied' : (snap.connectors?.length?'Available':'Unknown'),
          wsOnline:snap.online,
          lastHeartbeatAt:snap.lastHeartbeat ?? null,
        };
      });

    t.done({count:base.length});
    return ok(res, base);
  } catch(e:any){ console.error('[list]',e?.message||e); return err(res,500); }
});

/* PATCH /v1/chargers/:chargeBoxId/location */
router.patch('/:chargeBoxId/location', async (req:Request, res:Response)=>{
  const t = timed('chargers/location');
  try{
    const { chargeBoxId } = req.params;
    const { latitude, longitude, address } = (req.body||{}) as {latitude:number;longitude:number;address?:string|null};
    const lat = Number(latitude), lon = Number(longitude);
    if (!isValidLatLon(lat, lon)) return err(res,400,'invalid_parameters');
    // Alguns ambientes possuem duas versões da função RPC (com e sem p_upsert)
    // Para evitar ambiguidade, sempre enviamos p_upsert
    const rpc = await withTimeout<any>(sb.rpc('set_cp_location', {
      p_charge_box_id: String(chargeBoxId),
      p_lat: lat,
      p_lon: lon,
      p_address: address ?? null,
      p_upsert: true,
    }));
    if (!rpc || rpc.error) { console.error('[rpc set_cp_location]', rpc?.error?.message||rpc?.error||'timeout'); return err(res,500); }
    t.done(); return ok(res, { ok:true });
  } catch(e:any){ console.error('[patch location]',e?.message||e); return err(res,500); }
});

/* POST /v1/chargers/:chargeBoxId/location (alias do PATCH) */
router.post('/:chargeBoxId/location', async (req:Request, res:Response)=>{
  const t = timed('chargers/location(post)');
  try{
    const { chargeBoxId } = req.params;
    const { latitude, longitude, address } = (req.body||{}) as {latitude:number;longitude:number;address?:string|null};
    const lat = Number(latitude), lon = Number(longitude);
    if (!isValidLatLon(lat, lon)) return err(res,400,'invalid_parameters');
    const rpc = await withTimeout<any>(sb.rpc('set_cp_location', {
      p_charge_box_id: String(chargeBoxId),
      p_lat: lat,
      p_lon: lon,
      p_address: address ?? null,
      p_upsert: true,
    }));
    if (!rpc || rpc.error) { console.error('[rpc set_cp_location]', rpc?.error?.message||rpc?.error||'timeout'); return err(res,500); }
    t.done(); return ok(res, { ok:true });
  } catch(e:any){ console.error('[post location]',e?.message||e); return err(res,500); }
});

export default router;
