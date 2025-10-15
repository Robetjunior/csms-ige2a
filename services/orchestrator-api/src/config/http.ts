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

    // Para SSE (/v1/stream), ser mais permissivo
    const isSSE = req.url?.includes('/v1/stream');
    
    // Sem origem (ex.: curl/supertest) => permitir
    if (!allowed || !origin) {
      return cb(null, {
        origin: true,
        credentials: true,
        methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
        allowedHeaders: ['Content-Type','X-API-Key','Cache-Control','Last-Event-ID'],
        exposedHeaders: ['Content-Type','Cache-Control','Connection'],
        optionsSuccessStatus: 204,
      });
    }

    const ok = allowed.includes(origin);
    
    // Para SSE, permitir sempre origens localhost
    const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
    const allowOrigin = isSSE ? (ok || isLocalhost) : ok;
    
    return cb(null, {
      origin: allowOrigin, // true/false: se false, o CORS não será aplicado
      credentials: true,
      methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
      allowedHeaders: ['Content-Type','X-API-Key','Cache-Control','Last-Event-ID'],
      exposedHeaders: ['Content-Type','Cache-Control','Connection'],
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
