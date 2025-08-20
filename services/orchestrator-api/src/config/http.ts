import cors, { CorsOptionsDelegate, CorsRequest } from 'cors';
import rateLimit from 'express-rate-limit';

function parseOrigins(raw?: string): string[] | null {
  if (!raw) return null;
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

export function buildCors() {
  const allowed = parseOrigins(process.env.DASHBOARD_ORIGINS ?? process.env.DASHBOARD_ORIGIN);

  // Tipar o delegate com CorsRequest corrige o problema de tipos
  const delegate: CorsOptionsDelegate<CorsRequest> = (req, cb) => {
    // CorsRequest não tem req.header(); usar req.headers.origin
    const origin = (req.headers?.origin || req.headers?.Origin) as string | undefined;

    // Sem origem (ex.: curl/supertest) => permitir
    if (!allowed || !origin) {
      return cb(null, {
        origin: true,
        credentials: true,
        methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
        allowedHeaders: ['Content-Type','X-API-Key'],
        optionsSuccessStatus: 204,
      });
    }

    const ok = allowed.includes(origin);
    return cb(null, {
      origin: ok, // true/false: se false, o CORS não será aplicado
      credentials: true,
      methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
      allowedHeaders: ['Content-Type','X-API-Key'],
      optionsSuccessStatus: 204,
    });
  };

  return cors(delegate);
}

export function buildRateLimiter() {
  return rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    max: Number(process.env.RATE_LIMIT_MAX ?? '120'),
    standardHeaders: true,
    legacyHeaders: false,
  });
}
