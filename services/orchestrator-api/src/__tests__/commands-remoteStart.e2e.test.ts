// src/__tests__/commands-remoteStart.e2e.test.ts
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const CBID = 'CB-E2E-RS-01';
const IDTAG = 'ID-E2E-TEST';
const CONNECTOR = 2;

before(async () => {
  await pg.query(
    `DELETE FROM orchestrator.commands
      WHERE command_type='RemoteStart'
        AND charge_box_id=$1
        AND payload->>'idTag'=$2
        AND COALESCE((payload->>'connectorId')::int,0)=COALESCE($3::int,0)`,
    [CBID, IDTAG, CONNECTOR],
  );
});

after(async () => {
  await closeDbPools();
});

test('401 unauthorized quando X-API-Key incorreta (se habilitado)', async (t) => {
  if (process.env.ORCH_API_KEY) {
    await request(app)
      .post('/v1/commands/remoteStart')
      .set('X-API-Key', 'WRONG-KEY')
      .send({ chargeBoxId: CBID, idTag: IDTAG, connectorId: CONNECTOR })
      .expect(401);
  } else {
    t.diagnostic('ORCH_API_KEY não definido — teste pulado');
  }
});

test('400 invalid_payload quando faltar campos obrigatórios', async () => {
  const r = await request(app)
    .post('/v1/commands/remoteStart')
    .set('X-API-Key', process.env.ORCH_API_KEY || '')
    .send({})
    .expect(400);

  assert.equal(r.body.error, 'invalid_payload');
  assert.ok(Array.isArray(r.body.details));
});

test('202 cria comando RemoteStart e retorna status=sent', async () => {
  const r = await request(app)
    .post('/v1/commands/remoteStart')
    .set('X-API-Key', process.env.ORCH_API_KEY || '')
    .send({ chargeBoxId: CBID, idTag: IDTAG, connectorId: CONNECTOR })
    .expect(202);

  assert.ok('commandId' in r.body);
  assert.equal(r.body.status, 'sent');

  const { rows } = await pg.query(
    `SELECT id, command_type, transaction_id, charge_box_id, status, payload
       FROM orchestrator.commands
      WHERE id = $1::bigint`,
    [r.body.commandId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command_type, 'RemoteStart');
  assert.equal(rows[0].charge_box_id, CBID);
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].transaction_id, null);
  // jsonb -> objeto já parseado pelo pg: rows[0].payload.idTag
  assert.equal((rows[0].payload.idTag || rows[0].payload?.idtag), IDTAG);
  assert.equal(Number(rows[0].payload.connectorId), CONNECTOR);
});

test('200 idempotentDuplicate=true quando já existe comando ativo', async () => {
  const r = await request(app)
    .post('/v1/commands/remoteStart')
    .set('X-API-Key', process.env.ORCH_API_KEY || '')
    .send({ chargeBoxId: CBID, idTag: IDTAG, connectorId: CONNECTOR })
    .expect(200);

  assert.ok('commandId' in r.body);
  assert.equal(r.body.idempotentDuplicate, true);
  assert.ok(['pending', 'sent', 'accepted'].includes(r.body.status));
});

test('400 invalid_payload quando connectorId for inválido', async () => {
  const r = await request(app)
    .post('/v1/commands/remoteStart')
    .set('X-API-Key', process.env.ORCH_API_KEY || '')
    .send({ chargeBoxId: CBID, idTag: IDTAG, connectorId: 'abc' })
    .expect(400);

  assert.equal(r.body.error, 'invalid_payload');
});
