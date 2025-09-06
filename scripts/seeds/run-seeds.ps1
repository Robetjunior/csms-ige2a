# scripts/seeds/run-seeds.ps1
$ErrorActionPreference = 'Stop'

# Ajuste se seu container tiver outro nome
$PG_CONT = 'csms_postgres'
$DB = 'csms'
$USER = 'csms'

# Caminhos locais (relativos à raiz do repo)
$SeedDir = Join-Path $PSScriptRoot .
$PrereqsLocal = Join-Path $SeedDir '00_prereqs.sql'
$BillingLocal = Join-Path $SeedDir '01_billing_inserts.sql'

# Caminhos no container
$PrereqsRemote = '/tmp/00_prereqs.sql'
$BillingRemote = '/tmp/01_billing_inserts.sql'

Write-Host ">> Copiando seeds para o container..."
docker cp "$PrereqsLocal"  "${PG_CONT}:$PrereqsRemote"
docker cp "$BillingLocal"  "${PG_CONT}:$BillingRemote"

Write-Host ">> Normalizando quebras de linha (CRLF -> LF) e removendo ^Z..."
docker exec -i $PG_CONT bash -lc "set -e; sed -i 's/\r$//' $PrereqsRemote $BillingRemote; tr -d '\032' < $PrereqsRemote > /tmp/_00; tr -d '\032' < $BillingRemote > /tmp/_01; mv /tmp/_00 $PrereqsRemote; mv /tmp/_01 $BillingRemote"

Write-Host ">> Executando 00_prereqs.sql..."
docker exec -it $PG_CONT psql -U $USER -d $DB -v ON_ERROR_STOP=1 --echo-errors -f $PrereqsRemote

Write-Host ">> Executando 01_billing_inserts.sql..."
docker exec -it $PG_CONT psql -U $USER -d $DB -v ON_ERROR_STOP=1 --echo-errors -f $BillingRemote

Write-Host ">> Conferindo invoices..."
docker exec -it $PG_CONT psql -U $USER -d $DB -c "SELECT id, session_fk, transaction_id, total_br FROM orchestrator.invoices ORDER BY started_at DESC;"
