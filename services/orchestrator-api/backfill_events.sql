INSERT INTO orchestrator.ocpp_events (id, tipo, charge_box_id, transaction_id, id_tag, payload, created_at)
SELECT
  e.id,
  e.event_type      AS tipo,
  e.charge_box_id,
  e.transaction_pk  AS transaction_id,
  e.id_tag,
  e.payload,
  e.created_at
FROM public.events e
-- Evite duplicar IDs que já existam
LEFT JOIN orchestrator.ocpp_events o ON o.id = e.id
WHERE o.id IS NULL;