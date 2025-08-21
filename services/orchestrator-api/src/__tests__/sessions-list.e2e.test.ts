// src/__tests__/sessions-list.e2e.test.ts
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

function isoMinus(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const API_KEY: string = process.env.ORCH_API_KEY ?? 'minha_chave_super_secreta';
const A = 9301;
const B = 9302;
const C = 9303;

function withAuth<T extends request.Test>(r: T): T {
  return r.set({ 'X-API-Key': API_KEY });
}

before(async () => {
  await pg.query(`DELETE FROM orchestrator.sessions WHERE transaction_id IN ($1,$2,$3)`, [A, B, C]);

  await pg.query(
    `INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason)
     VALUES ($1,'CB-X','ID-AAA',$2,NULL,NULL)`,
    [A, isoMinus(30)],
  );
  await pg.query(
    `INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason)
     VALUES ($1,'CB-X','ID-BBB',$2,$3,'Remote')`,
    [B, isoMinus(60), isoMinus(10)],
  );
  await pg.query(
    `INSERT INTO orchestrator.sessions (transaction_id, charge_box_id, id_tag, started_at, stopped_at, stop_reason)
     VALUES ($1,'CB-Y','ID-AAA',$2,NULL,NULL)`,
    [C, isoMinus(5)],
  );
});

after(async () => {
  await closeDbPools();
});

test('filtra por charge_box_id=CB-X', async () => {
  const r = await withAuth(
    request(app).get('/v1/sessions').query({ charge_box_id: 'CB-X', sort: 'asc' })
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.ok(r.body.items.every((s: any) => s.charge_box_id === 'CB-X'));
});

test('filtra por status=active', async () => {
  const r = await withAuth(
    request(app).get('/v1/sessions').query({ status: 'active' })
  ).expect(200);

  assert.equal(r.body.count, r.body.items.length);
  assert.ok(r.body.items.every((s: any) => s.status === 'active'));
});

test('filtra por id_tag', async () => {
  const r = await withAuth(
    request(app).get('/v1/sessions').query({ id_tag: 'ID-AAA' })
  ).expect(200);

  assert.ok(r.body.items.length > 0);
  for (const it of r.body.items) assert.equal(it.id_tag, 'ID-AAA');
});

test('paginacao + ordenacao', async () => {
  const r1 = await withAuth(
    request(app).get('/v1/sessions?sort=asc&limit=1&offset=0')
  ).expect(200);

  const r2 = await withAuth(
    request(app).get('/v1/sessions?sort=asc&limit=1&offset=1')
  ).expect(200);

  assert.ok(r1.body.items[0].started_at <= r2.body.items[0].started_at);
});

test('intervalo de datas (from)', async () => {
  const from = isoMinus(20);
  const r = await withAuth(
    request(app).get('/v1/sessions').query({ from })
  ).expect(200);

  assert.ok(r.body.items.every((s: any) => new Date(s.started_at) >= new Date(from)));
});

test('filtra por transaction_id', async () => {
  const r = await withAuth(
    request(app).get('/v1/sessions').query({ transaction_id: C })
  ).expect(200);

  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].transaction_id, C);
});
