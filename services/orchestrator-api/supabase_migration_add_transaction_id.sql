-- Adiciona coluna transaction_id em public.ocpp_events e índices básicos
BEGIN;

ALTER TABLE IF EXISTS public.ocpp_events
  ADD COLUMN IF NOT EXISTS transaction_id integer;

-- Índices úteis para consultas
CREATE INDEX IF NOT EXISTS idx_ocpp_events_event_type ON public.ocpp_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ocpp_events_transaction_id ON public.ocpp_events(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_events_charge_box_id ON public.ocpp_events(charge_box_id);
CREATE INDEX IF NOT EXISTS idx_ocpp_events_created_at ON public.ocpp_events(created_at);

COMMIT;