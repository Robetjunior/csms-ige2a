# 🔌 Guia Completo - Simulador OCPP para CSMS

## ✅ Status dos Endpoints

**TODOS OS ENDPOINTS ESTÃO FUNCIONANDO CORRETAMENTE!**

### 🌐 URLs do Sistema
- **Frontend Dashboard**: `http://localhost:5173/`
- **Backend API**: `http://localhost:3000/`
- **SSE Stream**: `http://localhost:3000/v1/stream`
- **OCPP WebSocket**: `ws://localhost:3000/ocpp/CentralSystemService/<CHARGE_BOX_ID>`
- **Eventos OCPP**: `http://localhost:3000/v1/ocpp/events` (POST)

### 🔑 Autenticação
- **API Key**: `minha_chave_super_secreta` (para endpoints protegidos)
- **Header**: `X-API-Key: minha_chave_super_secreta`

## 🚀 Como Testar Telemetria em Tempo Real

### 1. Teste Rápido com Script Pronto
```bash
# Execute o script de teste incluído no projeto
node test-telemetria-simples.js
```

### 2. Verificar Resultados no Frontend
1. Abra: `http://localhost:5173/`
2. Observe as seções "Telemetria" e "Status dos Carregadores"
3. Os dados aparecem em tempo real via SSE

### 3. Teste Manual via cURL

#### StatusNotification
```bash
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "CB-TESTE-01",
    "payload": {
      "connectorId": 1,
      "status": "Available",
      "errorCode": "NoError"
    }
  }'
```

#### StartTransaction
```bash
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StartTransaction",
    "transactionId": 1001,
    "chargeBoxId": "CB-TESTE-01",
    "idTag": "USER123",
    "payload": {
      "connectorId": 1,
      "meterStart": 1000,
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

#### MeterValues (Telemetria)
```bash
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "MeterValues",
    "transactionId": 1001,
    "chargeBoxId": "CB-TESTE-01",
    "payload": {
      "connectorId": 1,
      "meterValue": [{
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
        "sampledValue": [
          {"value": "7500", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
          {"value": "50000", "measurand": "Power.Active.Import", "unit": "W"},
          {"value": "230.5", "measurand": "Voltage", "unit": "V"}
        ]
      }]
    }
  }'
```

#### StopTransaction
```bash
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StopTransaction",
    "transactionId": 1001,
    "chargeBoxId": "CB-TESTE-01",
    "reason": "Local",
    "payload": {
      "meterStop": 15000,
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

## 🔧 Configuração de Simuladores OCPP

### Para Simuladores Comerciais

#### 1. **OCPP Simulator (Online)**
- **URL WebSocket**: `ws://localhost:3000/ocpp/CentralSystemService/`
- **Charge Point ID**: Use um ID único (ex: `CB-SIM-001`)
- **Protocolo**: OCPP 1.6J
- **Subprotocolo**: `ocpp1.6`

#### 2. **SteVe (OCPP Backend)**
- Configure como Central System
- **Endpoint**: `ws://localhost:3000/ocpp/CentralSystemService/`
- **Charge Point ID**: Defina um ID único

#### 3. **Simulador Node.js Simples**
```javascript
const WebSocket = require('ws');

const chargeBoxId = 'CB-SIM-001';
const wsUrl = `ws://localhost:3000/ocpp/CentralSystemService/${chargeBoxId}`;

const ws = new WebSocket(wsUrl, 'ocpp1.6');

ws.on('open', () => {
  console.log('Conectado ao CSMS');
  
  // Enviar BootNotification
  const bootNotification = [
    2, // CALL
    "1", // Message ID
    "BootNotification",
    {
      "chargePointVendor": "Simulator",
      "chargePointModel": "Test-v1.0"
    }
  ];
  
  ws.send(JSON.stringify(bootNotification));
});

ws.on('message', (data) => {
  console.log('Recebido:', data.toString());
});
```

## 📊 Teste de SSE (Server-Sent Events)

### Teste via JavaScript (Browser)
```javascript
const eventSource = new EventSource('http://localhost:3000/v1/stream');

eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  console.log('Dados recebidos via SSE:', data);
};

eventSource.onerror = function(event) {
  console.error('Erro SSE:', event);
};
```

### Teste via cURL
```bash
curl -N http://localhost:3000/v1/stream
```

## 🎯 Simuladores Recomendados

### 1. **OCPP Simulator Online**
- **URL**: https://www.websocket.org/echo.html
- Configure para conectar em: `ws://localhost:3000/ocpp/CentralSystemService/CB-TEST-01`

### 2. **Postman/Insomnia**
- Use para testar endpoints REST
- Configure WebSocket para OCPP

### 3. **wscat (Linha de Comando)**
```bash
npm install -g wscat
wscat -c ws://localhost:3000/ocpp/CentralSystemService/CB-TEST-01 -s ocpp1.6
```

## ✅ Verificação dos Resultados

### 1. **No Frontend (http://localhost:5173/)**
- Seção "Telemetria": Dados em tempo real
- "Status dos Carregadores": Status atual
- "Sessões Ativas": Transações em andamento

### 2. **Logs do Backend**
- Verifique o terminal onde o backend está rodando
- Logs mostram eventos recebidos e processados

### 3. **Teste de Conectividade**
```bash
# Verificar se backend está rodando
curl http://localhost:3000/health

# Verificar SSE
curl -N http://localhost:3000/v1/stream
```

## 🔍 Troubleshooting

### Problema: Endpoint 404
- ✅ **Solução**: Use `/v1/ocpp/events` (não `/v1/events`)

### Problema: SSE não funciona
- Verifique se o frontend está conectado
- Abra DevTools → Network → EventSource

### Problema: WebSocket não conecta
- Verifique se o backend está rodando na porta 3000
- Use o protocolo correto: `ocpp1.6`

## 📝 Exemplo Completo de Uso

```bash
# 1. Iniciar backend
cd services/orchestrator-api
npm run dev

# 2. Iniciar frontend
cd services/web-dashboard  
npm run dev

# 3. Testar telemetria
node test-telemetria-simples.js

# 4. Abrir frontend
# http://localhost:5173/

# 5. Verificar dados em tempo real
```

---

**✨ Tudo funcionando perfeitamente! Os dados de telemetria aparecem em tempo real no frontend via SSE.**

## 📋 Endpoints e Configurações

### 🌐 URLs do Sistema
- **Frontend Dashboard**: http://localhost:5173/
- **Backend API**: http://localhost:3000/
- **SSE Stream**: http://localhost:3000/v1/stream
- **OCPP WebSocket**: `ws://localhost:3000/ocpp/CentralSystemService/<CHARGE_BOX_ID>`

### 🔑 Autenticação
- **API Key**: `minha_chave_super_secreta`
- **Header**: `X-API-Key: minha_chave_super_secreta`

## 🎯 Configuração do Simulador OCPP

### Para Simuladores Comerciais (SteVe, OCPP Simulator, etc.)

```
Protocolo: WebSocket
URL: ws://localhost:3000/ocpp/CentralSystemService/CB-SIMULATOR-01
Subprotocolo: ocpp1.6
Charge Box ID: CB-SIMULATOR-01 (ou qualquer ID único)
```

### Para Simuladores Online

1. **OCPP Simulator Online**:
   - URL: `ws://localhost:3000/ocpp/CentralSystemService/CB-WEB-01`
   - Protocol: OCPP 1.6
   - Charge Point ID: `CB-WEB-01`

2. **SteVe (Steve)**:
   - Central System URL: `ws://localhost:3000/ocpp/CentralSystemService/`
   - Charge Box ID: `CB-STEVE-01`

## 🛠️ Simulador Simples via WebSocket

### Usando Node.js WebSocket Client

```javascript
const WebSocket = require('ws');

const CHARGE_BOX_ID = 'CB-SIMULATOR-01';
const CSMS_URL = `ws://localhost:3000/ocpp/CentralSystemService/${CHARGE_BOX_ID}`;

const ws = new WebSocket(CSMS_URL, 'ocpp1.6');

ws.on('open', () => {
  console.log('Conectado ao CSMS');
  
  // Enviar BootNotification
  const bootNotification = [
    2, // Call
    "1", // Message ID
    "BootNotification",
    {
      chargePointVendor: "Simulator",
      chargePointModel: "Test-Model-1",
      chargePointSerialNumber: "SIM-001",
      firmwareVersion: "1.0.0"
    }
  ];
  
  ws.send(JSON.stringify(bootNotification));
});

ws.on('message', (data) => {
  console.log('Recebido:', data.toString());
});
```

## 📊 Eventos OCPP para Testar

### 1. StatusNotification (Status do Conector)
```json
{
  "type": "StatusNotification",
  "chargeBoxId": "CB-SIMULATOR-01",
  "timestamp": "2025-01-02T10:00:00Z",
  "payload": {
    "connectorId": 1,
    "status": "Available",
    "errorCode": "NoError"
  }
}
```

### 2. StartTransaction (Início de Carregamento)
```json
{
  "type": "StartTransaction",
  "transactionId": 12345,
  "chargeBoxId": "CB-SIMULATOR-01",
  "idTag": "USER-001",
  "timestamp": "2025-01-02T10:05:00Z",
  "payload": {
    "connectorId": 1,
    "idTag": "USER-001",
    "meterStart": 0
  }
}
```

### 3. MeterValues (Telemetria)
```json
{
  "type": "MeterValues",
  "transactionId": 12345,
  "chargeBoxId": "CB-SIMULATOR-01",
  "timestamp": "2025-01-02T10:06:00Z",
  "payload": {
    "connectorId": 1,
    "transactionId": 12345,
    "meterValue": [{
      "timestamp": "2025-01-02T10:06:00Z",
      "sampledValue": [{
        "value": "50.5",
        "context": "Sample.Periodic",
        "measurand": "Power.Active.Import",
        "unit": "kW"
      }, {
        "value": "220.5",
        "context": "Sample.Periodic",
        "measurand": "Voltage",
        "unit": "V"
      }]
    }]
  }
}
```

### 4. StopTransaction (Fim do Carregamento)
```json
{
  "type": "StopTransaction",
  "transactionId": 12345,
  "chargeBoxId": "CB-SIMULATOR-01",
  "reason": "Remote",
  "timestamp": "2025-01-02T10:30:00Z",
  "payload": {
    "transactionId": 12345,
    "meterStop": 25.5,
    "reason": "Remote"
  }
}
```

## 🧪 Scripts de Teste Prontos

### 1. Teste Rápido via cURL
```bash
# Enviar evento via API REST
curl -X POST http://localhost:3000/v1/ocpp/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: minha_chave_super_secreta" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "CB-CURL-01",
    "timestamp": "2025-01-02T10:00:00Z",
    "payload": {
      "connectorId": 1,
      "status": "Available",
      "errorCode": "NoError"
    }
  }'
```

### 2. Teste SSE
```bash
# Escutar eventos SSE
curl -N http://localhost:3000/v1/stream
```

## 🎮 Simuladores Recomendados

### 1. **OCPP Simulator (Desktop)**
- Download: https://github.com/steve-community/steve
- Configuração: URL `ws://localhost:3000/ocpp/CentralSystemService/`

### 2. **Simulador Web Simples**
- Use o script `test-integration-complete.js` que criamos
- Execute: `node test-integration-complete.js`

### 3. **Postman/Insomnia**
- Configure requests POST para `/v1/ocpp/events`
- Adicione header `X-API-Key: minha_chave_super_secreta`

## 🔍 Como Verificar se Está Funcionando

### 1. **Frontend Dashboard**
- Acesse: http://localhost:5173/
- Verifique se mostra "Conectado" no status SSE
- Observe os eventos aparecendo em tempo real

### 2. **Logs do Backend**
- Verifique o terminal do backend
- Deve mostrar conexões WebSocket e eventos recebidos

### 3. **Teste de Conectividade**
```bash
# Verificar se backend está rodando
curl http://localhost:3000/health

# Verificar se frontend está rodando  
curl http://localhost:5173/

# Testar SSE
curl -N http://localhost:3000/v1/stream
```

## 🚨 Troubleshooting

### Problema: "Connection refused"
- ✅ Verifique se o backend está rodando na porta 3000
- ✅ Verifique se o frontend está rodando na porta 5173

### Problema: "SSE não conecta"
- ✅ Verifique se não há firewall bloqueando
- ✅ Teste com `curl -N http://localhost:3000/v1/stream`

### Problema: "Eventos não aparecem no frontend"
- ✅ Verifique se a API Key está correta
- ✅ Verifique se os eventos estão sendo enviados corretamente
- ✅ Abra o DevTools do navegador para ver erros

## 📱 Exemplo Completo de Uso

1. **Inicie o backend** (se não estiver rodando)
2. **Inicie o frontend** (já está rodando em http://localhost:5173/)
3. **Execute o teste**: `node test-integration-complete.js`
4. **Abra o dashboard**: http://localhost:5173/
5. **Observe os dados** aparecendo em tempo real!

---

**🎯 URL Principal para Simulador OCPP:**
```
ws://localhost:3000/ocpp/CentralSystemService/<SEU_CHARGE_BOX_ID>
```

Substitua `<SEU_CHARGE_BOX_ID>` por um ID único como `CB-SIMULATOR-01`, `CB-TEST-01`, etc.