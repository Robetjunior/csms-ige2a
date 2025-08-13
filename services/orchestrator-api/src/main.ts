import express from 'express';
import { checkPg, checkMaria } from './db';

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/db/health', async (_req, res) => {
  try {
    const [pgOk, mariaOk] = await Promise.all([checkPg(), checkMaria()]);
    res.json({ postgres: pgOk ? 'up' : 'down', mariadb: mariaOk ? 'up' : 'down' });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.listen(3000, () => {
  console.log('Orchestrator API rodando na porta 3000');
});