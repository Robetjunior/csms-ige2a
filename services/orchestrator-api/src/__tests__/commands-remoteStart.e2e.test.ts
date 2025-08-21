// src/__tests__/commands-remoteStop.e2e.test.ts
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const API_KEY: string = process.env.ORCH_API_KEY ?? 'minha_chave_super_secreta';
const TX = 9101;

function withAuth<T extends request.Test>(r: T): T {
  return r.set({ 'X-API-Key': API_KEY });
}

before(async () => {
  await pg.query('DELETE FROM orchestrator.commands WHERE transaction_id = $1', [TX]);
  await pg.query('DELETE FROM public.events WHERE transaction_pk = $1', [TX]);

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

after(async () => {
  await closeDbPools();
});

test('should create RemoteStop and complete after StopTransaction', async () => {
  const r1 = await withAuth(
    request(app).post('/v1/commands/remoteStop').send({ transactionId: TX })
  ).expect(202);
  assert.ok('commandId' in r1.body);
  assert.equal(r1.body.status, 'sent');

  const now = new Date().toISOString();
  const ev = {
    type: 'StopTransaction',
    transactionId: TX,
    reason: 'Remote',
    timestamp: now,
    payload: { eventId: `stop-${TX}`, timestamp: now },
  };

  const r2 = await withAuth(
    request(app).post('/v1/ocpp/events').send(ev)
  ).expect(202);
  assert.equal(r2.body.accepted, true);

  const r3 = await withAuth(
    request(app).get(`/v1/commands?transaction_id=${TX}`)
  ).expect(200);

  assert.ok(Array.isArray(r3.body));
  assert.equal(r3.body[0].transaction_id, TX);
  assert.equal(r3.body[0].status, 'completed');
});
