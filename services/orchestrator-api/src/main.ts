import http from 'node:http';
import app from './app';
import { csms } from './ocpp/csms';

const PORT = Number(process.env.PORT ?? '3000');
const server = http.createServer(app);
csms.start(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Orchestrator API rodando na porta ${PORT} 🚀`);
});
