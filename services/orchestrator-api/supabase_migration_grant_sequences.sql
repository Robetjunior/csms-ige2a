-- Corrige permissões de sequências para evitar "permission denied for sequence commands_id_seq"
-- Execute como um usuário com privilégios (ex.: postgres) no Supabase/DB

-- 1) Garantir GRANTs nas sequências do schema orchestrator (onde está a tabela commands)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA orchestrator TO service_role;
GRANT USAGE, SELECT ON SEQUENCE orchestrator.commands_id_seq TO service_role;

-- Opcional: se o backend estiver usando a role "authenticated" em vez de service_role
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA orchestrator TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE orchestrator.commands_id_seq TO authenticated;

-- 2) (Opcional) Cobrir também o schema public, se houver tabelas/seqs relevantes
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 3) Default privileges: novas sequências herdarão os GRANTs automaticamente
ALTER DEFAULT PRIVILEGES IN SCHEMA orchestrator GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA orchestrator GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;

-- 4) Garantir ownership correto (apenas se necessário)
-- ALTER SEQUENCE orchestrator.commands_id_seq OWNED BY orchestrator.commands.id;

-- Observações:
-- - Em Supabase, a chave de serviço (SERVICE ROLE) corresponde à role de banco "service_role".
-- - Evite conceder permissões sensíveis à role "anon". Se seu backend usa anon/authenticated,
--   considere migrar para service_role para comandos administrativos.