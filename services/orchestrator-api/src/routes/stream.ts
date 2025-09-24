// services/orchestrator-api/src/routes/stream.ts
import { Router, Request, Response } from 'express';

export type BusEvent =
  | { type: 'session.started'; chargeBoxId: string; transactionId: number; idTag?: string | null; startedAt: string }
  | { type: 'session.stopped'; chargeBoxId: string; transactionId: number; stoppedAt: string; reason?: string }
  | { type: 'status.changed'; chargeBoxId: string; connectorId: number; status: string; updatedAt: string }
  | { type: 'heartbeat'; chargeBoxId: string; at: string };

const clients = new Set<Response>();

export const streamRouter = Router();

/** GET /v1/stream  (SSE) */
streamRouter.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // ping/keepalive a cada 15s
  const ping = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
  }, 15000);

  clients.add(res);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

/** Publica para todos os clientes SSE */
export function publish(evt: BusEvent) {
  const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch { /* best-effort */ }
  }
}
