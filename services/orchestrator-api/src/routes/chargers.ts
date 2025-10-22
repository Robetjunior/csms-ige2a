import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';
import { csms } from '../ocpp/csms';
import { requireApiKey } from '../middleware/apiKey';

const router = Router();
router.use(requireApiKey);

/* helpers */
const num = (v:any, d?:number)=> (v==null||v==='') ? (d??null) : (Number.isFinite(Number(v))? Number(v): null);
const isValidLatLon = (lat:number|null, lon:number|null)=> lat!=null && lon!=null && lat>=-90 && lat<=90 && lon>=-180 && lon<=180;
const haversineKm = (a:number,b:number,c:number,d:number)=>{ const R=6371, toR=(x:number)=>x*Math.PI/180; const dLat=toR(c-a), dLon=toR(d-b); const s=Math.sin(dLat/2)**2+Math.cos(toR(a))*Math.cos(toR(c))*Math.sin(dLon/2)**2; return 2*R*Math.asin(Math.sqrt(s)); };
const timed = (label:string)=>{ const t0=Date.now(); return { t0, done:(extra?:any)=>console.log({route:label,duration_ms:Date.now()-t0,...(extra||{})}) }; };
const ok = (res:Response, data:any)=> res.json(data);
const err = (res:Response, code:number, error='internal_error', detail?:any)=> res.status(code).json({ error, detail });

/* GET /v1/chargers/online */
router.get('/online', async (req:Request, res:Response) => {
  const t = timed('chargers/online');
  const sinceMinutes = num(req.query.sinceMinutes, 7) ?? 7;
  const limit = num(req.query.limit, 200) ?? 200;
  try {
    const cutoff = new Date(Date.now() - sinceMinutes*60_000).toISOString();
    const v = await sb.from('last_heartbeat_v').select('charge_box_id,last_heartbeat_at').gte('last_heartbeat_at', cutoff);
    const hb = new Map<string,string>();
    if (!v.error && v.data) for (const r of v.data as any[]) hb.set(r.charge_box_id, r.last_heartbeat_at);
    else {
      const e = await sb.from('ocpp_events').select('charge_box_id,created_at').eq('event_type','Heartbeat').gte('created_at', cutoff).limit(5000);
      if (!e.error && e.data) for (const r of e.data as any[]) hb.set(r.charge_box_id, r.created_at);
    }
    const ws = new Set(csms.listOnline());
    const ids = Array.from(new Set([...ws, ...hb.keys()])).slice(0, limit);
    const st = await sb.from('last_status_v').select('charge_box_id,status,last_status_at').in('charge_box_id', ids);
    const status = new Map<string,{s:string,t:string|null}>();
    if (!st.error && st.data) for (const r of st.data as any[]) status.set(r.charge_box_id, { s:r.status, t:r.last_status_at });

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
    const cb = await sb.from('charge_boxes_v').select('charge_box_id,site,lat,lon,address').eq('charge_box_id', id).maybeSingle();
    const snap = csms.getStatusSnapshot(id);
    t.done();
    return ok(res, {
      chargeBoxId:id,
      site: cb.data?.site ?? null,
      lat: cb.data?.lat ?? null,
      lon: cb.data?.lon ?? null,
      address: cb.data?.address ?? null,
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

    const q = await sb.from('charge_boxes_v')
      .select('charge_box_id,site,lat,lon')
      .gte('lat', minLat).lte('lat', maxLat)
      .gte('lon', minLon).lte('lon', maxLon);

    const base = (q.data||[])
      .filter((r:any)=> r.lat!=null && r.lon!=null)
      .map((r:any)=>({
        chargeBoxId: r.charge_box_id,
        site: r.site ?? null,
        coords: { lat:Number(r.lat), lon:Number(r.lon) },
        distanceKm: haversineKm(lat as number, lon as number, Number(r.lat), Number(r.lon)),
      }))
      .sort((a,b)=>a.distanceKm-b.distanceKm)
      .slice(0, limit)
      .map(b=>{
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
    const { error } = await sb.rpc('set_cp_location', { p_charge_box_id:String(chargeBoxId), p_lat:lat, p_lon:lon, p_address: address ?? null });
    if (error) { console.error('[rpc set_cp_location]', error.message||error); return err(res,500); }
    t.done(); return ok(res, { ok:true });
  } catch(e:any){ console.error('[patch location]',e?.message||e); return err(res,500); }
});

export default router;
