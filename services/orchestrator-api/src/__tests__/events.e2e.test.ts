// src/__tests__/events.e2e.test.ts
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const TEST_NS = `E2E-${Date.now()}`;
const API_KEY: string = process.env.ORCH_API_KEY ?? 'minha_chave_super_secreta';
let BASE_FROM: Date;

type Seed = {
  event_type: string;
  charge_box_id: string | null;
  connector_pk: number | null;
  transaction_pk: number | null;
  payload?: any;
  dtSec?: number; // deslocamento em segundos
  key: string;    // sufixo do unique_key
};

async function seedEvent(s: Seed) {
  const createdAt = new Date(BASE_FROM.getTime() + (s.dtSec ?? 0) * 1000).toISOString();
  await pg.query(
    `
    INSERT INTO public.events
      (source, event_type, payload, charge_box_id, connector_pk, transaction_pk, id_tag, unique_key, created_at)
    VALUES
      ($1,    $2,         $3::jsonb, $4,            $5,           $6,              $7,    $8,         $9::timestamptz)
    ON CONFLICT (unique_key) DO NOTHING
    `,
    [
      'orchestrator',
      s.event_type,
      JSON.stringify(s.payload ?? {}),
      s.charge_box_id,
      s.connector_pk,
      s.transaction_pk,
      TEST_NS,
      `${TEST_NS}:${s.key}`,
      createdAt,
    ],
  );
}

async function getIdByKey(key: string): Promise<number | null> {
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM public.events WHERE unique_key = $1 LIMIT 1`,
    [`${TEST_NS}:${key}`],
  );
  return rows[0]?.id ?? null;
}

before(async () => {
  BASE_FROM = new Date();
  await pg.query(`DELETE FROM public.events WHERE id_tag = $1`, [TEST_NS]);

  await seedEvent({ key: 'A1', event_type: 'StartTransaction', charge_box_id: 'CB-A', connector_pk: 1, transaction_pk: 1001, dtSec: 1, payload: { meterStart: 10 } });
  await seedEvent({ key: 'A2', event_type: 'StopTransaction',  charge_box_id: 'CB-A', connector_pk: 1, transaction_pk: 1001, dtSec: 2, payload: { meterStop: 20 } });

  await seedEvent({ key: 'A3', event_type: 'MeterValues',      charge_box_id: 'CB-A', connector_pk: 2, transaction_pk: 1001, dtSec: 3 });
  await seedEvent({ key: 'A4', event_type: 'StopTransaction',  charge_box_id: 'CB-A', connector_pk: 2, transaction_pk: 1002, dtSec: 4 });

  await seedEvent({ key: 'B1', event_type: 'StartTransaction', charge_box_id: 'CB-B', connector_pk: 1, transaction_pk: 2001, dtSec: 5 });
  await seedEvent({ key: 'B2', event_type: 'StopTransaction',  charge_box_id: 'CB-B', connector_pk: 1, transaction_pk: 2001, dtSec: 6 });
  await seedEvent({ key: 'B3', event_type: 'Heartbeat',        charge_box_id: 'CB-B', connector_pk: 2, transaction_pk: 2002, dtSec: 7 });
  await seedEvent({ key: 'B4', event_type: 'StartTransaction', charge_box_id: 'CB-B', connector_pk: 2, transaction_pk: 2002, dtSec: 8 });
});

after(async () => {
  await pg.query(`DELETE FROM public.events WHERE id_tag = $1`, [TEST_NS]);
  await closeDbPools();
});

function fromParam() {
  return `from=${encodeURIComponent(BASE_FROM.toISOString())}`;
}

function withAuth<T extends request.Test>(r: T): T {
  return r.set({ 'X-API-Key': API_KEY });
}

test('filtra por event_type=StopTransaction', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&event_type=StopTransaction&id_tag=${TEST_NS}`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 3);
  for (const it of r.body.items) {
    assert.equal(it.event_type, 'StopTransaction');
    assert.equal(it.id_tag, TEST_NS);
  }
});

test('filtra por charge_box_id=CB-A', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&charge_box_id=CB-A&id_tag=${TEST_NS}`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 4);
  for (const it of r.body.items) {
    assert.equal(it.charge_box_id, 'CB-A');
    assert.equal(it.id_tag, TEST_NS);
  }
});

test('filtra por connector_pk=2', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&connector_pk=2&id_tag=${TEST_NS}`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 4);
  for (const it of r.body.items) {
    assert.equal(it.connector_pk, 2);
    assert.equal(it.id_tag, TEST_NS);
  }
});

test('filtra por transaction_pk=1001', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&transaction_pk=1001&id_tag=${TEST_NS}`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 3);
  for (const it of r.body.items) {
    assert.equal(it.transaction_pk, 1001);
    assert.equal(it.id_tag, TEST_NS);
  }
});

test('filtra por id_tag (namespace)', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 8);
  for (const it of r.body.items) {
    assert.equal(it.id_tag, TEST_NS);
  }
});

test('intervalo de datas (from) pega apenas as fixtures', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 8);
});

test('pagina + ordena (sort=asc, limit=2, offset=1)', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}&sort=asc&limit=2&offset=1`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 2);
  assert.equal(typeof r.body.items[0].unique_key, 'undefined');
});

test('combina filtros (event_type=StartTransaction & charge_box_id=CB-B)', async () => {
  const r = await withAuth(
    request(app).get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}&event_type=StartTransaction&charge_box_id=CB-B`)
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.equal(r.body.items.length, 2);
  for (const it of r.body.items) {
    assert.equal(it.event_type, 'StartTransaction');
    assert.equal(it.charge_box_id, 'CB-B');
    assert.equal(it.id_tag, TEST_NS);
  }
});

test('GET /v1/events/:id (by-id)', async () => {
  const id = await getIdByKey('A1'); // StartTransaction CB-A tx=1001
  assert.ok(id, 'seed A1 id should exist');

  const r = await withAuth(
    request(app).get(`/v1/events/${id}`)
  ).expect(200);

  assert.equal(r.body.id, String(id));
  assert.equal(r.body.event_type, 'StartTransaction');
  assert.equal(r.body.charge_box_id, 'CB-A');
  assert.equal(r.body.transaction_pk, 1001);
  assert.equal(r.body.id_tag, TEST_NS);
  assert.ok(r.body.created_at);
  assert.deepEqual(r.body.payload ?? {}, { meterStart: 10 });
});
