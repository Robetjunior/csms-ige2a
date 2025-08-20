import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import request from 'supertest';

// define env antes de carregar app
process.env.DASHBOARD_ORIGINS = 'http://localhost:5173,http://example.com';

// carrega app só depois de setar env
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../app').default;

const ORIGIN_OK = 'http://example.com';
const ORIGIN_BAD = 'https://evil.test';

test('não envia CORS quando não há Origin (ex.: curl/supertest)', async () => {
  const r = await request(app).get('/health').expect(200);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('permite origem listada: Access-Control-Allow-Origin e credentials', async () => {
  const r = await request(app)
    .get('/health')
    .set('Origin', ORIGIN_OK)
    .expect(200);

  assert.equal(r.headers['access-control-allow-origin'], ORIGIN_OK);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
});

test('bloqueia origem fora da whitelist (sem ACAO no response)', async () => {
  const r = await request(app)
    .get('/health')
    .set('Origin', ORIGIN_BAD)
    .expect(200);

  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('preflight OPTIONS para origem permitida retorna 204 com cabeçalhos CORS', async () => {
  const r = await request(app)
    .options('/v1/events')
    .set('Origin', ORIGIN_OK)
    .set('Access-Control-Request-Method', 'GET')
    .set('Access-Control-Request-Headers', 'Content-Type, X-API-Key')
    .expect(204);

  assert.equal(r.headers['access-control-allow-origin'], ORIGIN_OK);
  assert.ok(r.headers['access-control-allow-methods']);
  assert.ok(r.headers['access-control-allow-headers']);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
});
