// src/__tests__/remoteStop.e2e.test.ts
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const TX = 9101;

describe('POST /v1/commands/remoteStop + StopTransaction flow', () => {
  beforeAll(async () => {
    // 0) limpeza de vestígios de execuções anteriores
    await pg.query('DELETE FROM orchestrator.commands WHERE transaction_id = $1', [TX]);
    await pg.query('DELETE FROM public.events WHERE transaction_pk = $1', [TX]);

    // 1) (re)cria sessão aberta / reabre se já existir
    await pg.query(
      `INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason)
       VALUES ($1, 'CB-TEST', 'ID-TEST', now(), NULL, NULL)
       ON CONFLICT (transaction_id) DO UPDATE
         SET stopped_at = NULL,
             stop_reason = NULL,
             charge_box_id = EXCLUDED.charge_box_id,
             id_tag = EXCLUDED.id_tag`,
      [TX],
    );
  });

  afterAll(async () => {
    await closeDbPools(); // fecha pg e mariadb -> some o warning do Jest
  });

  it('should create RemoteStop and complete after StopTransaction', async () => {
    const r1 = await request(app)
      .post('/v1/commands/remoteStop')
      .send({ transactionId: TX })
      .expect(202);

    expect(r1.body).toHaveProperty('commandId');
    expect(r1.body.status).toBe('sent');

    const now = new Date().toISOString();
    const ev = {
      type: 'StopTransaction',
      transactionId: TX,
      reason: 'Remote',
      timestamp: now,
      payload: { eventId: `stop-${TX}`, timestamp: now },
    };

    const r2 = await request(app)
      .post('/v1/ocpp/events')
      .send(ev)
      .expect(202);

    expect(r2.body.accepted).toBe(true);

    const r3 = await request(app)
      .get(`/v1/commands?transaction_id=${TX}`)
      .expect(200);

    expect(Array.isArray(r3.body)).toBe(true);
    expect(r3.body[0].transaction_id).toBe(TX);
    expect(r3.body[0].status).toBe('completed');
  });
});
