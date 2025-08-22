// src/app.ts
import express, { Request, Response } from 'express';
import path from 'path';
import swaggerUi from 'swagger-ui-express';

import eventsRouter from './routes/events';
import commandsRouter from './routes/commands';
import sessionsRouter from './routes/sessions';
import metricsRouter from './routes/metrics';
import metricsAdvancedRouter from './routes/metrics-advanced';

// ✅ importe estes dois
import tariffsRouter from './routes/tariffs';
import billingRouter from './routes/billing';

import { pg } from './db';
import { buildCors, buildRateLimiter } from './config/http';
import { requireApiKey } from './middleware/apiKey';

const app = express();

app.use(express.json());
app.use(buildCors());

// Health/Ready SEM auth
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));
app.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pg.query('SELECT 1');
    return res.json({ ok: true, pg: 'up' });
  } catch (e) {
    console.error('[ready] pg check failed:', e);
    return res.status(500).json({ ok: false, pg: 'down' });
  }
});

// ---- DOCS ----
const OPENAPI_FILE = path.resolve(process.cwd(), 'openapi.yaml');
const DOCS_ENABLED = (process.env.ENABLE_DOCS ?? '1') !== '0';

if (DOCS_ENABLED) {
  app.get('/openapi.yaml', (_req, res) => {
    res.type('text/yaml').sendFile(OPENAPI_FILE);
  });
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(undefined, {
      swaggerOptions: { url: '/openapi.yaml' },
      customSiteTitle: 'Orchestrator API — Docs',
    }),
  );
} else {
  console.warn('[docs] desabilitado (ENABLE_DOCS=0)');
}

// 🔐 A partir daqui, /v1/** exige X-API-Key
app.use('/v1/', requireApiKey());

// Rate limit só após autenticar
app.use('/v1/', buildRateLimiter());

// Rotas
app.use('/v1/events', eventsRouter);
app.use('/v1/ocpp',  eventsRouter);
app.use('/v1/commands', commandsRouter);
app.use('/v1/sessions', sessionsRouter);
app.use('/v1/metrics', metricsRouter);
app.use('/v1/metrics', metricsAdvancedRouter);

// ✅ monte aqui:
app.use('/v1/tariffs', tariffsRouter);
app.use('/v1/billing', billingRouter);

export default app;
