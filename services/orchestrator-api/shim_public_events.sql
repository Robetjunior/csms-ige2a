DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
             ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = 'events' AND c.relkind = 'r') THEN
    EXECUTE 'DROP TABLE public.events CASCADE';
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n
                ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relname = 'events' AND c.relkind IN ('v','m')) THEN
    EXECUTE 'DROP VIEW IF EXISTS public.events CASCADE';
    EXECUTE 'DROP MATERIALIZED VIEW IF EXISTS public.events CASCADE';
  END IF;
END
\$\$;

CREATE VIEW public.events AS
SELECT
  id,
  created_at,
  source,
  event_type,
  charge_box_id,
  connector_pk,
  transaction_pk,
  id_tag,
  payload
FROM orchestrator.events;