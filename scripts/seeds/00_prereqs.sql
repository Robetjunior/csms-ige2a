BEGIN;
CREATE SCHEMA IF NOT EXISTS orchestrator;

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
        NULL;
    END;
  END IF;
END$$;

COMMIT;
