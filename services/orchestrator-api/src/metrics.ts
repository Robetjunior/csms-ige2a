// services/orchestrator-api/src/metrics.ts
import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

const register = new client.Registry();

// métricas padrão do Node.js/processo
client.collectDefaultMetrics({
  register,
  prefix: 'orchestrator_',
});

// contadores por rota/status
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests total',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// histograma de latência (segundos)
export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10],
  registers: [register],
});

// middleware para instrumentar todas as rotas
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = (req as any).route?.path || req.path || 'unmatched';
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durSeconds);
  });
  next();
}

// handler do /metrics
export async function metricsHandler(req: Request, res: Response) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
