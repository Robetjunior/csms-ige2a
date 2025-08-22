DROP VIEW IF EXISTS orchestrator.events CASCADE;

CREATE VIEW orchestrator.events (
  id,
  created_at,
  source,
  event_type,
  charge_box_id,
  connector_pk,
  transaction_pk,
  id_tag,
  payload
) AS
SELECT
  e.id,
  e.created_at,
  'orchestrator'::text       AS source,
  e.tipo                     AS event_type,
  e.charge_box_id,
  NULL::integer              AS connector_pk,
  e.transaction_id           AS transaction_pk,
  e.id_tag,
  e.payload
FROM orchestrator.ocpp_events e;