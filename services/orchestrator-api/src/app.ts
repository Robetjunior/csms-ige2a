// src/app.ts
import express, { Request, Response } from 'express';
import eventsRouter from './routes/events';
import commandsRouter from './routes/commands';
import sessionsRouter from './routes/sessions';
import { pg } from './db';
import { buildCors, buildRateLimiter } from './config/http';
import { requireApiKey } from './middleware/apiKey';

const app = express();

app.use(express.json());
app.use(buildCors());

// Health/Ready SEM auth (padrão para monitoria; se quiser proteger, mova-os abaixo)
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

// 🔐 A partir daqui, /v1/** exige X-API-Key
app.use('/v1/', requireApiKey());

// Rate limit só após autenticar
app.use('/v1/', buildRateLimiter());

// Rotas
app.use('/v1/events', eventsRouter);
app.use('/v1/ocpp',  eventsRouter);
app.use('/v1/commands', commandsRouter);
app.use('/v1/sessions', sessionsRouter);

export default app;
