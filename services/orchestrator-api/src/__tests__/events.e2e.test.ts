import request from 'supertest';
import app from '../app';
import { pg, closeDbPools } from '../db';

const TEST_NS = `E2E-${Date.now()}`;
let BASE_FROM: Date;

type Seed = {
  event_type: string;
  charge_box_id: string | null;
  connector_pk: number | null;
  transaction_pk: number | null;
  payload?: any;
  // deslocamento em segundos a partir de BASE_FROM
  dtSec?: number;
  key: string;
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

describe('GET /v1/events — filtros, paginação e ordenação', () => {
  beforeAll(async () => {
    // marco temporal: tudo o que inserirmos será >= BASE_FROM
    BASE_FROM = new Date();

    // Limpa vestígios anteriores (id_tag = TEST_NS)
    await pg.query(`DELETE FROM public.events WHERE id_tag = $1`, [TEST_NS]);

    // Carrega fixtures (8 eventos controlados)
    // CB-A: connector 1/2, txs 1001/1002, tipos diversos
    await seedEvent({ key: 'A1', event_type: 'StartTransaction', charge_box_id: 'CB-A', connector_pk: 1, transaction_pk: 1001, dtSec: 1 });
    await seedEvent({ key: 'A2', event_type: 'StopTransaction',  charge_box_id: 'CB-A', connector_pk: 1, transaction_pk: 1001, dtSec: 2 });

    await seedEvent({ key: 'A3', event_type: 'MeterValues',      charge_box_id: 'CB-A', connector_pk: 2, transaction_pk: 1001, dtSec: 3 });
    await seedEvent({ key: 'A4', event_type: 'StopTransaction',  charge_box_id: 'CB-A', connector_pk: 2, transaction_pk: 1002, dtSec: 4 });

    // CB-B
    await seedEvent({ key: 'B1', event_type: 'StartTransaction', charge_box_id: 'CB-B', connector_pk: 1, transaction_pk: 2001, dtSec: 5 });
    await seedEvent({ key: 'B2', event_type: 'StopTransaction',  charge_box_id: 'CB-B', connector_pk: 1, transaction_pk: 2001, dtSec: 6 });
    await seedEvent({ key: 'B3', event_type: 'Heartbeat',        charge_box_id: 'CB-B', connector_pk: 2, transaction_pk: 2002, dtSec: 7 });
    await seedEvent({ key: 'B4', event_type: 'StartTransaction', charge_box_id: 'CB-B', connector_pk: 2, transaction_pk: 2002, dtSec: 8 });
  });

  afterAll(async () => {
    // Limpa e fecha pools
    await pg.query(`DELETE FROM public.events WHERE id_tag = $1`, [TEST_NS]);
    await closeDbPools();
  });

  function fromParam() {
    // usa o marco temporal para isolar SOMENTE nossas fixtures
    return `from=${encodeURIComponent(BASE_FROM.toISOString())}`;
  }

  it('filtra por event_type=StopTransaction', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&event_type=StopTransaction&id_tag=${TEST_NS}`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    expect(r.body.items.length).toBe(3); // A2, A4, B2
    for (const it of r.body.items) {
      expect(it.event_type).toBe('StopTransaction');
      expect(it.id_tag).toBe(TEST_NS);
    }
  });

  it('filtra por charge_box_id=CB-A', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&charge_box_id=CB-A&id_tag=${TEST_NS}`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    // A1, A2, A3, A4 => 4
    expect(r.body.items.length).toBe(4);
    for (const it of r.body.items) {
      expect(it.charge_box_id).toBe('CB-A');
      expect(it.id_tag).toBe(TEST_NS);
    }
  });

  it('filtra por connector_pk=2', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&connector_pk=2&id_tag=${TEST_NS}`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    // A3, A4, B3, B4 => 4
    expect(r.body.items.length).toBe(4);
    for (const it of r.body.items) {
      expect(it.connector_pk).toBe(2);
      expect(it.id_tag).toBe(TEST_NS);
    }
  });

  it('filtra por transaction_pk=1001', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&transaction_pk=1001&id_tag=${TEST_NS}`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    // A1 (Start) + A2 (Stop) + A3 (MeterValues) -> 3
    expect(r.body.items.length).toBe(3);
    for (const it of r.body.items) {
      expect(it.transaction_pk).toBe(1001); // <- agora vem número
      expect(it.id_tag).toBe(TEST_NS);
    }
  });

  it('filtra por id_tag (namespace)', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    expect(r.body.items.length).toBe(8);
    for (const it of r.body.items) {
      expect(it.id_tag).toBe(TEST_NS);
    }
  });

  it('intervalo de datas (from) pega apenas as fixtures', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    expect(r.body.items.length).toBe(8);
  });

  it('pagina + ordena (sort=asc, limit=2, offset=1)', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}&sort=asc&limit=2&offset=1`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    expect(r.body.items.length).toBe(2);
    // como criamos em ordem A1..B4, com sort=asc e offset=1 caímos em A2,A3
    expect(r.body.items[0].unique_key).toBeUndefined(); // não retornamos unique_key; apenas checagem de shape
  });

  it('combina filtros (event_type=StartTransaction & charge_box_id=CB-B)', async () => {
    const r = await request(app)
      .get(`/v1/events?${fromParam()}&id_tag=${TEST_NS}&event_type=StartTransaction&charge_box_id=CB-B`)
      .expect(200);

    expect(r.body.count).toBe(r.body.items.length);
    // B1, B4 => 2
    expect(r.body.items.length).toBe(2);
    for (const it of r.body.items) {
      expect(it.event_type).toBe('StartTransaction');
      expect(it.charge_box_id).toBe('CB-B');
      expect(it.id_tag).toBe(TEST_NS);
    }
  });
});
