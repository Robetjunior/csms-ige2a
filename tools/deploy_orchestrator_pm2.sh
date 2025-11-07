#!/usr/bin/env bash
set -euo pipefail

# Deploy do orchestrator-api via PM2 (sem Docker)
# Uso:
#   bash tools/deploy_orchestrator_pm2.sh \
#     --service-dir /opt/csms-ige2a/services/orchestrator-api \
#     --env-file /opt/csms-ige2a/.env \
#     --api-key minha_chave_super_secreta \
#     --tx 762474145 \
#     --cbid DRBAKANA-TEST-01

SERVICE_DIR="/opt/csms-ige2a/services/orchestrator-api"
ENV_FILE=""
API_KEY=""
TX=""
CBID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-dir) SERVICE_DIR="$2"; shift 2;;
    --env-file) ENV_FILE="$2"; shift 2;;
    --api-key) API_KEY="$2"; shift 2;;
    --tx) TX="$2"; shift 2;;
    --cbid) CBID="$2"; shift 2;;
    *) echo "[erro] argumento desconhecido: $1"; exit 1;;
  esac
done

require() { command -v "$1" >/dev/null || { echo "[erro] comando '$1' não encontrado"; exit 1; }; }
require pnpm; require pm2; require curl; command -v jq >/dev/null || { echo "[warn] jq não encontrado, instalando..."; sudo apt-get update && sudo apt-get install -y jq; }

[[ -d "$SERVICE_DIR" ]] || { echo "[erro] serviço não encontrado em $SERVICE_DIR"; exit 1; }
cd "$SERVICE_DIR"

if [[ -n "$ENV_FILE" && -f "$ENV_FILE" ]]; then
  echo "[env] carregando $ENV_FILE"
  set -a; source "$ENV_FILE"; set +a
fi

export NODE_ENV=production
export PORT=${PORT:-3000}
export PG_SSL_REJECT_UNAUTHORIZED=${PG_SSL_REJECT_UNAUTHORIZED:-0}

echo "[build] instalando deps e buildando"
pnpm install --prefer-frozen-lockfile
pnpm build

echo "[pm2] iniciando/reiniciando orchestrator-api"
if pm2 list | grep -q orchestrator-api; then
  pm2 restart orchestrator-api
else
  pm2 start dist/main.js --name orchestrator-api
fi
pm2 save || true

echo "[health] aguardando API ficar saudável"
for i in $(seq 1 30); do
  if curl -s http://localhost:3000/health | jq -e '.ok == true' >/dev/null 2>&1; then
    echo "[ok] API saudável"; break
  fi
  sleep 2
  [[ $i -eq 30 ]] && { echo "[erro] API não ficou saudável"; exit 1; }
done

if [[ -n "$TX" && -n "$CBID" && -n "$API_KEY" ]]; then
  echo "[teste] enviando RemoteStop para tx=$TX cbid=$CBID"
  RS=$(curl -s -w "\n%{http_code}" -X POST 'http://localhost:3000/v1/commands/remoteStop' \
      -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
      -d "{\"transactionId\":$TX,\"chargeBoxId\":\"$CBID\"}")
  BODY=$(echo "$RS" | head -n1)
  CODE=$(echo "$RS" | tail -n1)
  echo "[remoteStop] code=$CODE body=$BODY"
  CMD_ID=$(echo "$BODY" | jq -r '.commandId // empty')
  if [[ -n "$CMD_ID" ]]; then
    echo "[poll] acompanhando comando $CMD_ID por até 120s"
    for i in $(seq 1 30); do
      C=$(curl -s -H "X-API-Key: $API_KEY" "http://localhost:3000/v1/commands/$CMD_ID")
      ST=$(echo "$C" | jq -r '.status')
      echo "  - status=$ST"
      [[ "$ST" == "accepted" || "$ST" == "completed" ]] && break
      sleep 4
    done
    echo "[sessão] tx=$TX"
    curl -s -H "X-API-Key: $API_KEY" "http://localhost:3000/v1/sessions/$TX" | jq
    echo "[eventos] StopTransaction"
    curl -s -H "X-API-Key: $API_KEY" "http://localhost:3000/v1/events?event_type=StopTransaction&transaction_pk=$TX&limit=3&sort=desc" | jq
  else
    echo "[warn] RemoteStop sem commandId (code=$CODE) — verifique body acima"
  fi
fi

echo "[ok] deploy concluído"