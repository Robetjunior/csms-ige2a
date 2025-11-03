---
--- Supabase migration: ensure public.ocpp_events exposes event_type and transaction_id,
--- and create useful indexes on orchestrator.ocpp_events for performance.
---
--- This script is idempotent and safe to run multiple times.
---
--- IMPORTANT:
--- - public.ocpp_events is a VIEW (not a table). Columns are controlled by the view definition.
--- - Indexes cannot be created on a normal VIEW; create them on the base table
---   orchestrator.ocpp_events that the view selects from.
---
BEGIN;

-- 1) If the public.ocpp_events view still has the old column name 'tipo', rename it to 'event_type'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ocpp_events'
      AND column_name = 'tipo'
  ) THEN
    EXECUTE 'ALTER VIEW public.ocpp_events RENAME COLUMN tipo TO event_type';
  END IF;
END $$;

-- 2) Validate the presence of 'transaction_id' in the public.ocpp_events view.
--    If missing, emit a NOTICE. Adjust the view definition to include it when necessary.
DO $$
DECLARE has_tx_id BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ocpp_events'
      AND column_name = 'transaction_id'
  ) INTO has_tx_id;

  IF NOT has_tx_id THEN
    RAISE NOTICE 'public.ocpp_events is missing column transaction_id. Please ensure the view selects transaction_id from orchestrator.ocpp_events.';
  END IF;
END $$;

-- 3) Create indexes on the base table orchestrator.ocpp_events to accelerate common queries.
--    These match usage patterns in API routes filtering by event_type, transaction_id, charge_box_id, and created_at.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'orchestrator'
      AND table_name = 'ocpp_events'
  ) THEN
    -- Single-column indexes
    EXECUTE 'CREATE INDEX IF NOT EXISTS ocpp_events_event_type_idx ON orchestrator.ocpp_events (event_type)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ocpp_events_transaction_id_idx ON orchestrator.ocpp_events (transaction_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ocpp_events_charge_box_id_idx ON orchestrator.ocpp_events (charge_box_id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ocpp_events_created_at_idx ON orchestrator.ocpp_events (created_at)';

    -- Composite indexes for frequent filters/sorts
    EXECUTE 'CREATE INDEX IF NOT EXISTS ocpp_events_txid_event_type_idx ON orchestrator.ocpp_events (transaction_id, event_type)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ocpp_events_chargebox_created_idx ON orchestrator.ocpp_events (charge_box_id, created_at DESC)';
  ELSE
    RAISE NOTICE 'Base table orchestrator.ocpp_events not found; skipping index creation.';
  END IF;
END $$;

COMMIT;