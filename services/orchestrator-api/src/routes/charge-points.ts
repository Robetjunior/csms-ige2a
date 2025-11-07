// src/routes/charge-points.ts
import { Router, Request, Response } from 'express';
import { sb } from '../../supabase';
import { requireApiKey } from '../middleware/apiKey';
import { pg } from '../db';

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

// GET /v1/charge-points/near?lat=...&lon=...&maxKm=...&limit=...
router.get('/near', async (req: Request, res: Response) => {
  const t0 = Date.now();
  const rid = Math.random().toString(36).slice(2, 8);
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const maxKm = Number(req.query.maxKm ?? '10');
  const limitRaw = Number(req.query.limit ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(limitRaw, 200) : 50;

  // Log 1: início
  console.log(`[near:${rid}] start`);
  // Log 2: parâmetros normalizados
  console.log(`[near:${rid}] params`, { lat, lon, maxKm, limit });

  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'invalid_coordinates' });
    }

    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      // Log 3: início da transação + timeout
      console.log(`[near:${rid}] db.begin timeout=4s`);
      await client.query("SET LOCAL statement_timeout = '4s'");

      const sql = 'SELECT * FROM map_find_near($1,$2,$3,$4)';
      const { rows } = await client.query(sql, [
        lat,
        lon,
        Number.isFinite(maxKm) ? maxKm : 10,
        limit,
      ]);

      await client.query('COMMIT');
      // Log 4: resultado da consulta
      console.log(`[near:${rid}] db.query ok rows=${rows?.length ?? 0}`);

      const items: MapPoint[] = (rows ?? []).map((r: any) => ({
        id: String(r.id),
        nome: String(r.nome),
        endereco: r.endereco ?? null,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        source: String(r.source) as MapPoint['source'],
        distance_km: Number(r.distance_km ?? 0),
      }));

      // Log 5: fim com duração e contagem
      console.log(`[near:${rid}] done duration_ms=${Date.now() - t0} count=${items.length}`);
      return res.json({ items });
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      console.error(`[near:${rid}] error`, e?.message || e);
      return res.status(504).json({ error: 'near timeout/failed' });
    } finally {
      client.release();
    }
  } catch (e: any) {
    console.error('[charge-points/near] unexpected', e?.message || e);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v1/charge-points/in-bounds?latMin=...&latMax=...&lonMin=...&lonMax=...&limit=...
router.get('/in-bounds', async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const latMin = Number(req.query.latMin);
    const latMax = Number(req.query.latMax);
    const lonMin = Number(req.query.lonMin);
    const lonMax = Number(req.query.lonMax);
    const limit = Number(req.query.limit ?? '200');

    if (![latMin, latMax, lonMin, lonMax].every(Number.isFinite)) {
      return res.status(400).json({ error: 'invalid_bounds' });
    }

    const { data, error } = await sb.rpc('map_find_in_bounds', {
      p_lat_min: latMin,
      p_lat_max: latMax,
      p_lon_min: lonMin,
      p_lon_max: lonMax,
      p_limit: Number.isFinite(limit) ? limit : 200,
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
