import express, { Request, Response } from 'express';
import eventsRouter from './routes/events';
import commandsRouter from './routes/commands';
import { pg } from './db';

const app = express();
app.use(express.json());

// Health simples
app.get('/health', (_req: Request, res: Response) => res.json({ ok: true }));

// Ready com teste no Postgres
app.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pg.query('SELECT 1');
    return res.json({ ok: true, pg: 'up' });
  } catch (e) {
    console.error('[ready] pg check failed:', e);
    return res.status(500).json({ ok: false, pg: 'down' });
  }
});

app.use('/v1', eventsRouter);
app.use('/v1/commands', commandsRouter);

export default app;
