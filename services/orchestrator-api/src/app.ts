// src/app.ts
import express, { Request, Response } from 'express';
import path from 'path';
import swaggerUi from 'swagger-ui-express';

import eventsRouter from './routes/events';
import commandsRouter from './routes/commands';
import sessionsRouter from './routes/sessions';
import sessionsProgressRouter from './routes/sessions-progress';
import chargersRouter from './routes/chargers';
import metricsRouter from './routes/metrics';
import metricsAdvancedRouter from './routes/metrics-advanced';
import tariffsRouter from './routes/tariffs';
import billingRouter from './routes/billing';
import debugRouter from './routes/debug';
import actionsRouter from './routes/actions';
import ocppDebug from './routes/ocpp-debug';
import { streamRouter } from './routes/stream';

import { buildCors, buildRateLimiter } from './config/http';
import { requireApiKey } from './middleware/apiKey';

const app = express();

app.use(express.json());
app.use(buildCors());

// Health/Ready (sem auth)
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

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

// ---- Rotas públicas (se quiser proteger, mova após o middleware de auth) ----
app.use('/v1/debug', debugRouter);
app.use('/v1/ocpp', ocppDebug);

// 🔊 SSE público (não exige X-API-Key)
app.use('/v1/stream', streamRouter);

// 🔐 A partir daqui, /v1/** exige X-API-Key e rate limit
app.use('/v1', requireApiKey(), buildRateLimiter());

// ---- Rotas autenticadas ----
app.use('/v1/events', eventsRouter); // REST normal (não SSE)
app.use('/v1/commands', commandsRouter);
app.use('/v1/sessions', sessionsRouter);
app.use('/v1/sessions', sessionsProgressRouter);
app.use('/v1/chargers', chargersRouter);
app.use('/v1/actions', actionsRouter);
app.use('/v1/metrics', metricsRouter);
app.use('/v1/metrics-advanced', metricsAdvancedRouter);
app.use('/v1/tariffs', tariffsRouter);
app.use('/v1/billing', billingRouter);

export default app;
