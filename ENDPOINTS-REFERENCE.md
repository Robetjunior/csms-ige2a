# 📚 Referência Completa de Endpoints - CSMS

## 🌐 URLs Base
- **Frontend**: `http://localhost:5173/`
- **Backend API**: `http://localhost:3000/`

## 🔑 Autenticação
- **API Key**: `minha_chave_super_secreta`
- **Header**: `X-API-Key: minha_chave_super_secreta`

---

## 📡 Endpoints Públicos (Sem Autenticação)

### Health Check
```http
GET /health
```
**Resposta**: `{ "ok": true }`

### Métricas Prometheus
```http
GET /metrics
```

### SSE Stream (Tempo Real)
```http
GET /v1/stream
```
**Descrição**: Server-Sent Events para dados em tempo real
**Content-Type**: `text/event-stream`

### Debug OCPP
```http
GET /v1/debug/ocpp/online
GET /v1/debug/ocpp/resolve-tx/:tx
GET /v1/debug/ocpp/bindings
GET /v1/debug/ocpp/last-tx/:cbid
```

### OCPP Debug
```http
GET /v1/ocpp/online
GET /v1/ocpp/:cbid/snapshot
GET /v1/ocpp/tx-bindings
```

---

## 🔒 Endpoints Protegidos (Requerem API Key)

### Eventos OCPP
```http
POST /v1/ocpp/events
Content-Type: application/json

{
  "type": "StatusNotification|StartTransaction|MeterValues|StopTransaction",
  "transactionId": 1001,
  "chargeBoxId": "CB-001",
  "idTag": "USER123",
  "reason": "Local",
  "timestamp": "2024-12-24T10:30:00.000Z",
  "payload": { ... }
}
```

### Eventos (Consulta)
```http
GET /v1/events
GET /v1/events/:id
```
**Parâmetros de Query**:
- `event_type`: Tipo do evento
- `charge_box_id`: ID do carregador
- `connector_pk`: ID do conector
- `transaction_pk`: ID da transação
- `id_tag`: Tag do usuário
- `from`: Data inicial (ISO)
- `to`: Data final (ISO)
- `limit`: Limite de resultados (1-500, padrão: 50)
- `offset`: Offset para paginação (padrão: 0)
- `sort`: Ordenação (asc|desc, padrão: desc)

### Comandos
```http
GET /v1/commands
POST /v1/commands
GET /v1/commands/:id
```

### Sessões
```http
GET /v1/sessions
GET /v1/sessions/:transactionId
GET /v1/sessions/:transactionId/progress
```

### Carregadores
```http
GET /v1/chargers
POST /v1/chargers
GET /v1/chargers/:id
PUT /v1/chargers/:id
DELETE /v1/chargers/:id
```

### Ações
```http
POST /v1/actions/remote-start
POST /v1/actions/remote-stop
POST /v1/actions/unlock-connector
POST /v1/actions/reset
```

### Métricas
```http
GET /v1/metrics/overview
GET /v1/metrics/chargers
GET /v1/metrics/sessions
GET /v1/metrics/energy
```

### Métricas Avançadas
```http
GET /v1/metrics-advanced/energy-consumption
GET /v1/metrics-advanced/session-analytics
GET /v1/metrics-advanced/charger-utilization
```

### Tarifas
```http
GET /v1/tariffs
POST /v1/tariffs
GET /v1/tariffs/:id
PUT /v1/tariffs/:id
DELETE /v1/tariffs/:id
```

### Faturamento
```http
GET /v1/billing/invoices
GET /v1/billing/invoices/:id
GET /v1/billing/reports
```

### Telemetria
```http
GET /v1/telemetry/status
GET /v1/telemetry/sessions
GET /v1/telemetry/chargers
```

---

## 🔌 WebSocket OCPP

### Endpoint
```
ws://localhost:3000/ocpp/CentralSystemService/<CHARGE_BOX_ID>
```

### Protocolo
- **Subprotocolo**: `ocpp1.6`
- **Formato**: JSON-RPC 2.0

### Exemplo de Conexão
```javascript
const ws = new WebSocket(
  'ws://localhost:3000/ocpp/CentralSystemService/CB-001',
  'ocpp1.6'
);
```

---

## 📊 Exemplos de Uso

### 1. Enviar Evento OCPP
```bash
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "CB-001",
    "payload": {
      "connectorId": 1,
      "status": "Available",
      "errorCode": "NoError"
    }
  }'
```

### 2. Consultar Eventos
```bash
curl -H "X-API-Key: minha_chave_super_secreta" \
  "http://localhost:3000/v1/events?charge_box_id=CB-001&limit=10"
```

### 3. Iniciar Carregamento Remoto
```bash
curl -X POST http://localhost:3000/v1/actions/remote-start \
  -H "Content-Type: application/json" \
  -H "X-API-Key: minha_chave_super_secreta" \
  -d '{
    "chargeBoxId": "CB-001",
    "connectorId": 1,
    "idTag": "USER123"
  }'
```

### 4. Conectar SSE
```javascript
const eventSource = new EventSource('http://localhost:3000/v1/stream');

eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  console.log('Dados em tempo real:', data);
};
```

---

## 🔍 Códigos de Status

### Sucesso
- `200`: OK
- `201`: Criado
- `202`: Aceito (para eventos OCPP)

### Erro Cliente
- `400`: Requisição inválida
- `401`: Não autorizado
- `404`: Não encontrado
- `429`: Muitas requisições

### Erro Servidor
- `500`: Erro interno do servidor

---

## 🚀 Teste Rápido

### Script de Teste Completo
```bash
# 1. Verificar saúde
curl http://localhost:3000/health

# 2. Testar SSE
curl -N http://localhost:3000/v1/stream &

# 3. Enviar evento
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "CB-TEST",
    "payload": {"connectorId": 1, "status": "Available"}
  }'

# 4. Consultar eventos
curl -H "X-API-Key: minha_chave_super_secreta" \
  "http://localhost:3000/v1/events?limit=5"
```

---

## 📝 Notas Importantes

1. **Endpoints OCPP**: Use `/v1/ocpp/events` para enviar eventos
2. **SSE**: Dados aparecem automaticamente no frontend
3. **WebSocket**: Use protocolo `ocpp1.6`
4. **API Key**: Necessária para endpoints protegidos
5. **Rate Limiting**: Aplicado em endpoints autenticados

---

**✅ Todos os endpoints estão funcionais e testados!**