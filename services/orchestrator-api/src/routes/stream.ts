import { Router, Request, Response } from 'express';
import { z } from 'zod';

/* ============================ Tipos ============================ */
export type BusEvent =
  | { type: 'session.started'; chargeBoxId: string; transactionId: number; idTag?: string | null; startedAt: string }
  | { type: 'session.stopped'; chargeBoxId: string; transactionId: number; stoppedAt: string; reason?: string }
  | { type: 'status.changed'; chargeBoxId: string; connectorId: number; status: string; updatedAt: string }
  | { type: 'heartbeat';      chargeBoxId: string; at: string }
  | { type: 'telemetry.updated'; chargeBoxId: string; transactionId: number; telemetry: TelemetryData; updatedAt: string };

export type TelemetryData = {
  power_kw?: number;           // Potência atual em kW
  energy_kwh?: number;         // Energia acumulada em kWh
  voltage_v?: number;          // Tensão em V
  current_a?: number;          // Corrente em A
  soc_percent?: number;        // Estado de carga em %
  duration_seconds?: number;   // Duração da sessão em segundos
  temperature_c?: number;      // Temperatura em °C
};

type OutEventName = 'session-start' | 'session-end' | 'status-change' | 'heartbeat' | 'telemetry-updated';
type Format = 'sse' | 'ndjson';

type Client = {
  res: Response;
  format: Format;
  cbids: Set<string> | null;     // null = todos
  types: Set<OutEventName> | null;
  pingTimer: NodeJS.Timeout;
};

/* ============================ Helpers ============================ */
const StreamQuery = z.object({
  cbid:   z.string().optional(),                 // "A,B,C" ou omitido
  types:  z.string().optional(),                 // "heartbeat,status-change" ou omitido
  format: z.enum(['sse','ndjson']).optional().default('sse'),
  pingMs: z.coerce.number().int().min(5000).max(60000).optional().default(15000),
  apiKey: z.string().optional(),                 // API key via query parameter
});

const DEFAULT_TYPES: OutEventName[] = ['heartbeat','status-change','session-start','session-end','telemetry-updated'];

function mapInternalToExternal(e: BusEvent): { name: OutEventName; payload: any; cbid: string } {
  switch (e.type) {
    case 'session.started': return { name: 'session-start', cbid: e.chargeBoxId, payload: { ...e, type: 'session-start' } };
    case 'session.stopped': return { name: 'session-end',   cbid: e.chargeBoxId, payload: { ...e, type: 'session-end' } };
    case 'status.changed':  return { name: 'status-change', cbid: e.chargeBoxId, payload: { ...e, type: 'status-change' } };
    case 'heartbeat':       return { name: 'heartbeat',     cbid: e.chargeBoxId, payload: { ...e, type: 'heartbeat' } };
    case 'telemetry.updated': return { name: 'telemetry-updated', cbid: e.chargeBoxId, payload: { ...e, type: 'telemetry-updated' } };
  }
}

function toSet<T extends string>(csv?: string | undefined, allowed?: readonly T[]): Set<T> | null {
  if (!csv) return null;
  const out = new Set<T>();
  for (const raw of csv.split(',').map(s => s.trim()).filter(Boolean)) {
    const v = raw as T;
    if (!allowed || allowed.includes(v)) out.add(v);
  }
  return out.size ? out : null;
}

/* ============================ Estado ============================ */
const clients = new Set<Client>();

function writeToClient(c: Client, name: OutEventName, data: any) {
  if (c.format === 'sse') {
    c.res.write(`event: ${name}\n`);
    c.res.write(`data: ${JSON.stringify({ ...data, serverTime: new Date().toISOString() })}\n\n`);
  } else {
    c.res.write(JSON.stringify({ event: name, ...data, serverTime: new Date().toISOString() }) + '\n');
  }
}

/* ============================ Router ============================ */
export const streamRouter = Router();

/** GET / (SSE/NDJSON) — suporta filtros e formatos */
streamRouter.get('/', (req: Request, res: Response) => {
  const parsed = StreamQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', details: parsed.error.issues });
  }
  const q = parsed.data;

  // Verificar autenticação via header ou query parameter
  const apiKey = req.headers['x-api-key'] || q.apiKey;
  const expectedApiKey = process.env.API_KEY || 'minha_chave_super_secreta';
  
  if (!apiKey || apiKey !== expectedApiKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'API key required' });
  }
  const cbids = toSet<string>(q.cbid);
  const types = toSet<OutEventName>(q.types, DEFAULT_TYPES) ?? new Set(DEFAULT_TYPES as OutEventName[]);
  const format = q.format as Format;

  // Headers
  if (format === 'sse') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  } else {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
  }
  res.flushHeaders?.();

  // Hello inicial
  writeToClient(
    { res, format, cbids, types, pingTimer: setTimeout(() => {}, 0) } as Client,
    'heartbeat',
    { chargeBoxId: 'system', at: new Date().toISOString(), hello: true }
  );

  // Keepalive
  const pingTimer = setInterval(() => {
    try {
      writeToClient(
        { res, format, cbids, types, pingTimer } as Client,
        'heartbeat',
        { chargeBoxId: 'system', at: new Date().toISOString(), ping: true }
      );
    } catch {}
  }, q.pingMs);

  const client: Client = { res, format, cbids, types, pingTimer };
  clients.add(client);
  console.log(`🔗 Nova conexão SSE estabelecida. Total de clientes: ${clients.size}`);

  req.on('close', () => {
    clearInterval(pingTimer);
    clients.delete(client);
    console.log(`❌ Conexão SSE fechada. Total de clientes: ${clients.size}`);
  });
});

/** Broadcast público (usado pelo csms.ts) */
export function publish(evt: BusEvent) {
  const { name, payload, cbid } = mapInternalToExternal(evt);
  for (const c of clients) {
    // filtro por cbid
    if (c.cbids && !c.cbids.has(cbid)) continue;
    // filtro por tipo
    if (c.types && !c.types.has(name)) continue;
    try { writeToClient(c, name, payload); } catch {}
  }
}

// (removido) endpoint de teste '/test-event' — não necessário em produção
