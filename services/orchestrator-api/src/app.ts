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
import telemetryStatusRouter from './routes/telemetry-status';
import debugRouter from './routes/debug';
import actionsRouter from './routes/actions';
import ocppDebug from './routes/ocpp-debug';
import ocppEventsRouter from './routes/ocpp-events';
import { streamRouter } from './routes/stream';

import { buildCors, buildRateLimiter } from './config/http';
import { requireApiKey } from './middleware/apiKey';

import { metricsMiddleware, metricsHandler } from './metrics';

const app = express();

app.use(express.json());
app.use(buildCors());

// Health/Ready (sem auth)
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

// 🔭 Metrics Prometheus (sem auth)
app.use(metricsMiddleware);
app.get('/metrics', metricsHandler);

// ---- DOCS ----
const OPENAPI_FILE = path.resolve(process.cwd(), 'openapi.yaml');
const DOCS_ENABLED = (process.env.ENABLE_DOCS ?? '1') !== '0';

if (DOCS_ENABLED) {
  app.get('/openapi.yaml', (_req, res) => {
    res.type('text/yaml').sendFile(OPENAPI_FILE);
  });
} else {
  console.warn('[docs] desabilitado (ENABLE_DOCS=0)');
}

// ---- Rotas públicas (se quiser proteger, mova após o middleware de auth) ----
app.use('/v1/debug', debugRouter);
// Aplicar CORS explicitamente também no router /v1/ocpp (alguns agentes/OPTIONS não estavam herdando)
// Preflight OPTIONS explícito para garantir cabeçalhos CORS nas rotas /v1/ocpp
app.options('/v1/ocpp/*', buildCors());
app.use('/v1/ocpp', buildCors(), ocppDebug);
app.use('/v1/ocpp', buildCors(), ocppEventsRouter);

// 🔊 SSE público (não exige X-API-Key)
app.use('/v1/stream', streamRouter);

// 🔐 A partir daqui, /v1/** exige X-API-Key e rate limit
// Preflight OPTIONS para rotas autenticadas, deve vir ANTES do middleware de auth
app.options('/v1/*', buildCors());
// Também aplicamos CORS antes de exigir API Key, para que o navegador receba cabeçalhos CORS
app.use('/v1', buildCors());
app.use('/v1', requireApiKey());

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
app.use('/v1/telemetry', telemetryStatusRouter);

export default app;
