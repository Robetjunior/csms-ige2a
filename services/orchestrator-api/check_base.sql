SELECT id, tipo AS event_type, charge_box_id, transaction_id, id_tag, created_at
FROM orchestrator.ocpp_events
WHERE charge_box_id = 'dr_bacana_charger_01'
ORDER BY created_at DESC
LIMIT 10;