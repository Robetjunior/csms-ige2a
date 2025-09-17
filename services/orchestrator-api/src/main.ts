// src/main.ts
import http from 'node:http';
import app from './app';
import { csms } from './ocpp/csms';

const PORT = Number(process.env.PORT ?? '3000');

const server = http.createServer(app);

// inicia o servidor OCPP-J (WS) no mesmo HTTP server
csms.start(server);

// sobe HTTP (REST + WS upgrade)
server.listen(PORT, () => {
  console.log(`Orchestrator API rodando na porta ${PORT} 🚀`);
});
