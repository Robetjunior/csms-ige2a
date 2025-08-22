SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'orchestrator' AND table_name = 'events'
ORDER BY ordinal_position;