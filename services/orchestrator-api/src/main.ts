import http from 'node:http';
import app from './app';
import { csms } from './ocpp/csms';
import { checkPg } from './db';
import { checkSupabase } from '../supabase';

const PORT = Number(process.env.PORT ?? '3000');
const server = http.createServer(app);
csms.start(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Orchestrator API rodando na porta ${PORT} 🚀`);
  // Teste de conectividade com Supabase (HTTP) e Postgres (pg pool)
  (async () => {
    try {
      const okPg = await checkPg();
      console.log(`[startup] Supabase PG connectivity: ${okPg ? 'ok' : 'fail'}`);
      const { ok, error } = await checkSupabase();
      console.log(`[startup] Supabase HTTP SDK: ${ok ? 'ok' : 'fail'}${error ? ` (${error.message})` : ''}`);
    } catch (err: any) {
      console.error('[startup] Connectivity check error:', err?.message || String(err));
    }
  })();
});
