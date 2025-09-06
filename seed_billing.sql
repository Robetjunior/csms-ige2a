BEGIN;

-- garante o schema
CREATE SCHEMA IF NOT EXISTS orchestrator;

-- (opcional) garante UNIQUE em transaction_id para suportar upsert igual à sua API
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'orchestrator'
      AND indexname = 'sessions_transaction_id_key'
  ) THEN
    BEGIN
      ALTER TABLE orchestrator.sessions
        ADD CONSTRAINT sessions_transaction_id_key UNIQUE (transaction_id);
    EXCEPTION
      WHEN duplicate_object THEN
        -- índice/constraint já existe com outro nome: ignora
        NULL;
    END;
  END IF;
END$$;

-- =============== SESSÃO A (tx 9001) — upsert ===============
WITH s1 AS (
  INSERT INTO orchestrator.sessions
    (transaction_id, charge_box_id, id_tag, connector_id, mode,
     started_at, stopped_at, pricing_snapshot, energy_kwh, revenue_br)
  VALUES
    (9001, 'dr_bacana_charger_05', 'ABC12345', 1, 'AC',
     '2025-08-25T12:00:00Z'::timestamptz,
     '2025-08-25T13:30:00Z'::timestamptz,
     '{"tariff_id":5,"mode":"AC","price_kwh":2.5,"connection_fee":1,"idle_fee_per_minute":0.5,"idle_grace_minutes":10}'::jsonb,
     12.0, 71.0)
  ON CONFLICT (transaction_id) DO UPDATE
    SET charge_box_id     = EXCLUDED.charge_box_id,
        id_tag            = EXCLUDED.id_tag,
        connector_id      = EXCLUDED.connector_id,
        mode              = EXCLUDED.mode,
        started_at        = LEAST(orchestrator.sessions.started_at, EXCLUDED.started_at),
        stopped_at        = EXCLUDED.stopped_at,
        pricing_snapshot  = EXCLUDED.pricing_snapshot,
        energy_kwh        = EXCLUDED.energy_kwh,
        revenue_br        = EXCLUDED.revenue_br
  RETURNING id, transaction_id, charge_box_id, id_tag, started_at, stopped_at
)
INSERT INTO orchestrator.invoices
  (session_fk, transaction_id, charge_box_id, id_tag, started_at, stopped_at,
   energy_kwh, idle_minutes, total_br, breakdown)
SELECT
  s1.id, s1.transaction_id, s1.charge_box_id, s1.id_tag, s1.started_at, s1.stopped_at,
  12.0, 80, 71.0,
  jsonb_build_object(
    'connection_br', 1.0,
    'energy_br',     30.0,
    'idle_br',       40.0,
    'price_kwh',     2.5
  )
FROM s1
ON CONFLICT (session_fk) DO UPDATE
  SET stopped_at   = EXCLUDED.stopped_at,
      energy_kwh   = EXCLUDED.energy_kwh,
      idle_minutes = EXCLUDED.idle_minutes,
      total_br     = EXCLUDED.total_br,
      breakdown    = EXCLUDED.breakdown;

-- =============== SESSÃO B (tx 9002) — upsert ===============
WITH s2 AS (
  INSERT INTO orchestrator.sessions
    (transaction_id, charge_box_id, id_tag, connector_id, mode,
     started_at, stopped_at, pricing_snapshot, energy_kwh, revenue_br)
  VALUES
    (9002, 'CB-02', 'XYZ67890', 2, 'DC',
     '2025-08-26T09:00:00Z'::timestamptz,
     '2025-08-26T09:45:00Z'::timestamptz,
     '{"tariff_id":6,"mode":"DC","price_kwh":3.5,"connection_fee":2,"idle_fee_per_minute":0.2,"idle_grace_minutes":5}'::jsonb,
     8.5, 31.75)
  ON CONFLICT (transaction_id) DO UPDATE
    SET charge_box_id     = EXCLUDED.charge_box_id,
        id_tag            = EXCLUDED.id_tag,
        connector_id      = EXCLUDED.connector_id,
        mode              = EXCLUDED.mode,
        started_at        = LEAST(orchestrator.sessions.started_at, EXCLUDED.started_at),
        stopped_at        = EXCLUDED.stopped_at,
        pricing_snapshot  = EXCLUDED.pricing_snapshot,
        energy_kwh        = EXCLUDED.energy_kwh,
        revenue_br        = EXCLUDED.revenue_br
  RETURNING id, transaction_id, charge_box_id, id_tag, started_at, stopped_at
)
INSERT INTO orchestrator.invoices
  (session_fk, transaction_id, charge_box_id, id_tag, started_at, stopped_at,
   energy_kwh, idle_minutes, total_br, breakdown)
SELECT
  s2.id, s2.transaction_id, s2.charge_box_id, s2.id_tag, s2.started_at, s2.stopped_at,
  8.5, 0, 31.75,
  jsonb_build_object(
    'connection_br', 2.0,
    'energy_br',     29.75,   -- 8.5 * 3.5
    'idle_br',       0.0,
    'price_kwh',     3.5
  )
FROM s2
ON CONFLICT (session_fk) DO UPDATE
  SET stopped_at   = EXCLUDED.stopped_at,
      energy_kwh   = EXCLUDED.energy_kwh,
      idle_minutes = EXCLUDED.idle_minutes,
      total_br     = EXCLUDED.total_br,
      breakdown    = EXCLUDED.breakdown;

COMMIT;

-- Visualização: pretty (PG15 usa jsonb_pretty)
SELECT jsonb_pretty(jsonb_agg(to_jsonb(i) ORDER BY started_at DESC))
FROM orchestrator.invoices i;
