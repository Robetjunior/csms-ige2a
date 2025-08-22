SELECT id, created_at, source, event_type, charge_box_id, transaction_pk, id_tag
FROM orchestrator.events
WHERE charge_box_id = 'dr_bacana_charger_01'
ORDER BY created_at DESC
LIMIT 10;