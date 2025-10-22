// src/routes/charge-points.ts
import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';
import { requireApiKey } from '@src/middleware/apiKey';

const router = Router();

// aplica auth a todas as rotas deste módulo
router.use(requireApiKey);

type MapPoint = {
  id: string;
  nome: string;
  endereco: string | null;
  latitude: number;
  longitude: number;
  source: 'public' | 'orchestrator' | string;
  distance_km?: number;
};

function toNumber(v: unknown, def?: number): number | null {
  if (v == null || v === '') return def ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isValidLatLon(lat: number | null, lon: number | null): boolean {
  return lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function clampNum(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// GET /v1/charge-points/near
router.get('/near', async (req: Request, res: Response) => {
  try {
    const lat = toNumber(req.query.lat);
    const lon = toNumber(req.query.lon);
    let radius = toNumber(req.query.radius_km, 5) ?? 5;
    let limit = toNumber(req.query.limit, 50) ?? 50;
    let offset = toNumber(req.query.offset, 0) ?? 0;

    if (!isValidLatLon(lat, lon)) {
      return res.status(400).json({ error: 'invalid_parameters', details: { lat, lon } });
    }
    radius = clampNum(radius, 0.1, 100);
    limit = clampNum(limit, 1, 500);
    offset = Math.max(0, offset);

    if (!sb) return res.status(500).json({ error: 'internal_error' });
    const t0 = Date.now();

    const { data, error } = await sb.rpc('fn_map_points_by_distance', {
      p_lat: lat, p_lon: lon, p_radius_km: radius, p_limit: limit, p_offset: offset
    });

    if (error) {
      console.error('[charge-points/near] rpc error:', error?.message || error);
      return res.status(500).json({ error: 'internal_error' });
    }

    const items: MapPoint[] = (data ?? []).map((r: any) => ({
      id: String(r.id),
      nome: String(r.nome),
      endereco: r.endereco ?? null,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      source: String(r.source) as MapPoint['source'],
      distance_km: r.distance_km != null ? Number(r.distance_km) : undefined,
    }));

    console.log({ route: 'charge-points/near', q: req.query, duration_ms: Date.now() - t0, count: items.length });
    return res.json({ items });
  } catch (e: any) {
    console.error('[charge-points/near] unexpected', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v1/charge-points/in-bounds
router.get('/in-bounds', async (req: Request, res: Response) => {
  try {
    const minLat = toNumber(req.query.minLat);
    const minLon = toNumber(req.query.minLon);
    const maxLat = toNumber(req.query.maxLat);
    const maxLon = toNumber(req.query.maxLon);
    let limit = toNumber(req.query.limit, 200) ?? 200;
    let offset = toNumber(req.query.offset, 0) ?? 0;

    if (minLat == null || minLon == null || maxLat == null || maxLon == null) {
      return res.status(400).json({ error: 'invalid_parameters' });
    }
    if (minLat >= maxLat || minLon >= maxLon) {
      return res.status(400).json({ error: 'invalid_parameters' });
    }
    limit = clampNum(limit, 1, 1000);
    offset = Math.max(0, offset);

    if (!sb) return res.status(500).json({ error: 'internal_error' });
    const t0 = Date.now();

    const { data, error } = await sb.rpc('fn_map_points_by_bounds', {
      p_min_lat: minLat, p_min_lon: minLon, p_max_lat: maxLat, p_max_lon: maxLon,
      p_limit: limit, p_offset: offset
    });

    if (error) {
      console.error('[charge-points/in-bounds] rpc error:', error?.message || error);
      return res.status(500).json({ error: 'internal_error' });
    }

    const items: MapPoint[] = (data ?? []).map((r: any) => ({
      id: String(r.id),
      nome: String(r.nome),
      endereco: r.endereco ?? null,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      source: String(r.source) as MapPoint['source'],
    }));

    console.log({ route: 'charge-points/in-bounds', q: req.query, duration_ms: Date.now() - t0, count: items.length });
    return res.json({ items });
  } catch (e: any) {
    console.error('[charge-points/in-bounds] unexpected', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
