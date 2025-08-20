import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const TX = 9201;

before(async () => {
  await pg.query('DELETE FROM public.events WHERE transaction_pk = $1', [TX]);
  await pg.query('DELETE FROM orchestrator.sessions WHERE transaction_id = $1', [TX]);
  await pg.query(
    `INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason)
     VALUES ($1, 'CB-QA', 'ID-QA', now(), NULL, NULL)`,
    [TX],
  );
});

after(async () => {
  await closeDbPools();
});

test('retorna 200 para sessão ativa', async () => {
  const r = await request(app).get(`/v1/sessions/${TX}`).expect(200);
  assert.equal(r.body.transaction_id, TX);
  assert.equal(r.body.status, 'active');
  assert.equal(r.body.stopped_at, null);
  assert.equal(typeof r.body.duration_seconds, 'number');
});

test('retorna 200 e status=completed após StopTransaction', async () => {
  const now = new Date().toISOString();
  const ev = {
    type: 'StopTransaction',
    transactionId: TX,
    reason: 'Remote',
    timestamp: now,
    payload: { eventId: `stop-${TX}`, timestamp: now },
  };
  await request(app)
     .post('/v1/ocpp/events')
     .set('X-API-Key', process.env.ORCH_API_KEY || '')
     .send(ev)
     .expect(202);
  const r2 = await request(app).get(`/v1/sessions/${TX}`).expect(200);
  assert.equal(r2.body.transaction_id, TX);
  assert.equal(r2.body.status, 'completed');
  assert.ok(r2.body.stopped_at);
  assert.equal(r2.body.stop_reason, 'Remote');
});

test('retorna 404 para sessão inexistente', async () => {
  await request(app).get('/v1/sessions/999999').expect(404);
});
