import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const TX = 9101;

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
  const r1 = await request(app)
    .post('/v1/commands/remoteStop')
    .set('X-API-Key', process.env.ORCH_API_KEY || '')
    .send({ transactionId: TX })
    .expect(202);
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

  const r2 = await request(app)
   .post('/v1/ocpp/events')
   .set('X-API-Key', process.env.ORCH_API_KEY || '')
   .send(ev)
   .expect(202);
  assert.equal(r2.body.accepted, true);

  const r3 = await request(app)
   .get(`/v1/commands?transaction_id=${TX}`)
   .set('X-API-Key', process.env.ORCH_API_KEY || '')
   .expect(200);
  assert.ok(Array.isArray(r3.body));
  assert.equal(r3.body[0].transaction_id, TX);
  assert.equal(r3.body[0].status, 'completed');
});
