// src/main.ts
import express from 'express';
import { checkPg, checkMaria } from './db';
import eventsRouter from './routes/events';

const app = express();
app.use(express.json());

// Liveness check simples
app.get('/live', (_req, res) => res.json({ live: true }));

// Health básico (API respondendo)
app.get('/health', (_req, res) => res.json({ ok: true }));

// Readiness check — só retorna 200 quando bancos estão OK
app.get('/ready', async (_req, res) => {
  try {
    const [pgOk, mariaOk] = await Promise.all([checkPg(), checkMaria()]);
    const ready = pgOk && mariaOk;
    res.status(ready ? 200 : 503).json({
      ready,
      postgres: pgOk ? 'up' : 'down',
      mariadb: mariaOk ? 'up' : 'down',
    });
  } catch (e) {
    res.status(503).json({
      ready: false,
      error: (e as Error).message,
    });
  }
});

// Health dos bancos
app.get('/db/health', async (_req, res) => {
  try {
    const [pgOk, mariaOk] = await Promise.all([checkPg(), checkMaria()]);
    res.json({
      postgres: pgOk ? 'up' : 'down',
      mariadb: mariaOk ? 'up' : 'down',
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Rotas de eventos OCPP
app.use(eventsRouter);

app.listen(3000, () => {
  console.log('Orchestrator API rodando na porta 3000 🚀');
});
