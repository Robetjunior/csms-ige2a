# 🔌 Guia Completo - Testes com Simulador OCPP Externo

## 🎯 Objetivo
Este guia te ensina como conectar um simulador OCPP externo ao seu CSMS e realizar testes bidirecionais:
- **Simulador → CSMS**: Iniciar carregamento pelo simulador e ver dados no CSMS
- **CSMS → Simulador**: Iniciar carregamento pelo CSMS e ver dados no simulador

---

## 🌐 Configuração do Endpoint CSMS

### URL do WebSocket OCPP
```
ws://localhost:3000/ocpp/CentralSystemService/<SEU_CHARGE_BOX_ID>
```

### Configurações Necessárias
- **Protocolo**: WebSocket
- **Subprotocolo**: `ocpp1.6`
- **Porta**: `3000`
- **Path**: `/ocpp/CentralSystemService/`
- **Charge Box ID**: Escolha um ID único (ex: `CB-SIMULATOR-01`)

---

## 🛠️ Simuladores Recomendados

### 1. **SteVe (Steve) - Recomendado**
- **Download**: https://github.com/steve-community/steve
- **Configuração**:
  ```
  Central System URL: ws://localhost:3000/ocpp/CentralSystemService/
  Charge Point ID: CB-STEVE-01
  Protocol Version: OCPP 1.6
  ```

### 2. **OCPP Simulator Online**
- **URL**: https://www.websocket.org/echo.html
- **Configuração**:
  ```
  URL: ws://localhost:3000/ocpp/CentralSystemService/CB-WEB-01
  Protocol: ocpp1.6
  ```

### 3. **wscat (Linha de Comando)**
```bash
# Instalar wscat
npm install -g wscat

# Conectar ao CSMS
wscat -c ws://localhost:3000/ocpp/CentralSystemService/CB-TEST-01 -s ocpp1.6
```

### 4. **Simulador Node.js Personalizado**
```javascript
const WebSocket = require('ws');

const CHARGE_BOX_ID = 'CB-CUSTOM-01';
const CSMS_URL = `ws://localhost:3000/ocpp/CentralSystemService/${CHARGE_BOX_ID}`;

const ws = new WebSocket(CSMS_URL, 'ocpp1.6');

ws.on('open', () => {
  console.log('✅ Conectado ao CSMS');
  
  // Enviar BootNotification
  const bootNotification = [
    2, // Call
    "1", // Message ID
    "BootNotification",
    {
      chargePointVendor: "MeuSimulador",
      chargePointModel: "Teste-v1.0",
      chargePointSerialNumber: "SIM-001",
      firmwareVersion: "1.0.0"
    }
  ];
  
  ws.send(JSON.stringify(bootNotification));
});

ws.on('message', (data) => {
  console.log('📨 Recebido:', data.toString());
});
```

---

## 🚀 Passo a Passo para Testes

### **Pré-requisitos**
1. ✅ CSMS rodando em `http://localhost:3000/`
2. ✅ Dashboard rodando em `http://localhost:5173/`
3. ✅ Simulador OCPP externo configurado

### **Passo 1: Conectar Simulador ao CSMS**

1. **Configure seu simulador** com:
   ```
   URL: ws://localhost:3000/ocpp/CentralSystemService/CB-MEU-SIM-01
   Protocol: ocpp1.6
   Charge Point ID: CB-MEU-SIM-01
   ```

2. **Conecte o simulador** - você deve ver no console do CSMS:
   ```
   [OCPP] CB-MEU-SIM-01 connected
   ```

3. **Verifique no dashboard** (`http://localhost:5173/`):
   - O carregador deve aparecer na lista
   - Status deve mostrar "Available"

### **Passo 2: Teste Simulador → CSMS**

#### 2.1. Iniciar Carregamento pelo Simulador

**Via wscat:**
```bash
# Conectar
wscat -c ws://localhost:3000/ocpp/CentralSystemService/CB-TEST-01 -s ocpp1.6

# Enviar BootNotification
[2,"1","BootNotification",{"chargePointVendor":"Teste","chargePointModel":"v1.0"}]

# Enviar StatusNotification (Available)
[2,"2","StatusNotification",{"connectorId":1,"status":"Available","errorCode":"NoError"}]

# Iniciar Transação
[2,"3","StartTransaction",{"connectorId":1,"idTag":"USER123","meterStart":0,"timestamp":"2025-01-02T10:00:00.000Z"}]

# Enviar MeterValues (Telemetria)
[2,"4","MeterValues",{"connectorId":1,"transactionId":12345,"meterValue":[{"timestamp":"2025-01-02T10:01:00.000Z","sampledValue":[{"value":"7500","measurand":"Power.Active.Import","unit":"W"},{"value":"230.5","measurand":"Voltage","unit":"V"}]}]}]

# Parar Transação
[2,"5","StopTransaction",{"meterStop":15000,"timestamp":"2025-01-02T10:05:00.000Z","transactionId":12345}]
```

#### 2.2. Verificar Dados no CSMS

1. **No Dashboard** (`http://localhost:5173/`):
   - Vá para a página do carregador: `/chargers/CB-TEST-01`
   - Observe os dados de telemetria em tempo real
   - Verifique o status mudando: Available → Preparing → Charging → Finishing → Available

2. **Via API**:
   ```bash
   # Verificar eventos
   curl -H "X-API-Key: minha_chave_super_secreta" \
     "http://localhost:3000/v1/events?charge_box_id=CB-TEST-01&limit=10"
   
   # Verificar sessões ativas
   curl -H "X-API-Key: minha_chave_super_secreta" \
     "http://localhost:3000/v1/sessions"
   ```

### **Passo 3: Teste CSMS → Simulador**

#### 3.1. Iniciar Carregamento pelo CSMS

**Via API:**
```bash
# RemoteStart
curl -X POST http://localhost:3000/v1/commands/remoteStart \
  -H "Content-Type: application/json" \
  -H "X-API-Key: minha_chave_super_secreta" \
  -d '{
    "chargeBoxId": "CB-TEST-01",
    "connectorId": 1,
    "idTag": "USER123"
  }'
```

**Via Dashboard:**
1. Acesse `http://localhost:5173/chargers/CB-TEST-01`
2. Clique em "Iniciar Carregamento"
3. Preencha os dados e envie

#### 3.2. Verificar Comando no Simulador

No seu simulador, você deve receber:
```json
[2,"abc123","RemoteStartTransaction",{"idTag":"USER123","connectorId":1}]
```

**Responder no simulador:**
```json
[3,"abc123",{"status":"Accepted"}]
```

#### 3.3. Simular Resposta do Carregador

Após aceitar o comando, simule o processo de carregamento:

```bash
# 1. Status: Preparing
[2,"6","StatusNotification",{"connectorId":1,"status":"Preparing","errorCode":"NoError"}]

# 2. Iniciar Transação
[2,"7","StartTransaction",{"connectorId":1,"idTag":"USER123","meterStart":0,"timestamp":"2025-01-02T10:00:00.000Z"}]

# 3. Status: Charging
[2,"8","StatusNotification",{"connectorId":1,"status":"Charging","errorCode":"NoError"}]

# 4. Enviar MeterValues periodicamente
[2,"9","MeterValues",{"connectorId":1,"transactionId":12345,"meterValue":[{"timestamp":"2025-01-02T10:01:00.000Z","sampledValue":[{"value":"7500","measurand":"Power.Active.Import","unit":"W"}]}]}]
```

---

## 📊 Monitoramento em Tempo Real

### **1. Dashboard Web**
- **URL**: `http://localhost:5173/`
- **Página do Carregador**: `/chargers/<CHARGE_BOX_ID>`
- **Dados mostrados**:
  - Status atual do carregador
  - Telemetria em tempo real (potência, tensão, corrente)
  - Histórico de eventos
  - Sessões ativas

### **2. SSE (Server-Sent Events)**
```javascript
// Conectar ao stream de dados
const eventSource = new EventSource('http://localhost:3000/v1/stream');

eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  console.log('📊 Dados em tempo real:', data);
};
```

### **3. Logs do Console**
- **CSMS**: Verifique o terminal onde o backend está rodando
- **Simulador**: Observe as mensagens recebidas e enviadas

---

## 🔍 Verificação de Funcionamento

### **Checklist de Testes**

#### ✅ **Conectividade**
- [ ] Simulador conecta ao CSMS sem erros
- [ ] BootNotification é aceito
- [ ] Carregador aparece no dashboard

#### ✅ **Simulador → CSMS**
- [ ] StartTransaction cria sessão no CSMS
- [ ] MeterValues aparecem no dashboard
- [ ] StopTransaction finaliza sessão
- [ ] Status do carregador muda corretamente

#### ✅ **CSMS → Simulador**
- [ ] RemoteStart é recebido pelo simulador
- [ ] RemoteStop é recebido pelo simulador
- [ ] Comandos são processados corretamente
- [ ] Respostas são enviadas de volta

#### ✅ **Telemetria**
- [ ] Dados aparecem em tempo real no dashboard
- [ ] SSE funciona corretamente
- [ ] Histórico de eventos é salvo

---

## 🚨 Troubleshooting

### **Problema: Simulador não conecta**
```bash
# Verificar se CSMS está rodando
curl http://localhost:3000/health

# Verificar se porta 3000 está aberta
netstat -an | findstr :3000
```

### **Problema: Comandos não chegam ao simulador**
- ✅ Verifique se o Charge Box ID está correto
- ✅ Confirme que o simulador está conectado
- ✅ Verifique logs do CSMS para erros

### **Problema: Dados não aparecem no dashboard**
- ✅ Verifique se o frontend está rodando (`http://localhost:5173/`)
- ✅ Abra DevTools → Network → EventSource
- ✅ Confirme que SSE está conectado

### **Problema: API retorna 401**
- ✅ Adicione header: `X-API-Key: minha_chave_super_secreta`
- ✅ Verifique se a API Key está correta

---

## 📝 Exemplo Completo de Sessão

### **1. Preparação**
```bash
# Terminal 1: Iniciar CSMS (se não estiver rodando)
cd services/orchestrator-api
npm run dev

# Terminal 2: Iniciar Dashboard (se não estiver rodando)
cd services/web-dashboard
npm run dev

# Terminal 3: Conectar simulador
wscat -c ws://localhost:3000/ocpp/CentralSystemService/CB-TESTE-COMPLETO -s ocpp1.6
```

### **2. Sequência de Comandos no Simulador**
```json
// 1. Boot
[2,"1","BootNotification",{"chargePointVendor":"Teste","chargePointModel":"v1.0"}]

// 2. Status Available
[2,"2","StatusNotification",{"connectorId":1,"status":"Available","errorCode":"NoError"}]

// 3. Iniciar carregamento
[2,"3","StartTransaction",{"connectorId":1,"idTag":"USER123","meterStart":0,"timestamp":"2025-01-02T10:00:00.000Z"}]

// 4. Status Charging
[2,"4","StatusNotification",{"connectorId":1,"status":"Charging","errorCode":"NoError"}]

// 5. Telemetria (repetir várias vezes)
[2,"5","MeterValues",{"connectorId":1,"transactionId":12345,"meterValue":[{"timestamp":"2025-01-02T10:01:00.000Z","sampledValue":[{"value":"7500","measurand":"Power.Active.Import","unit":"W"},{"value":"230.5","measurand":"Voltage","unit":"V"}]}]}]

// 6. Parar carregamento
[2,"6","StopTransaction",{"meterStop":15000,"timestamp":"2025-01-02T10:05:00.000Z","transactionId":12345}]

// 7. Status Available
[2,"7","StatusNotification",{"connectorId":1,"status":"Available","errorCode":"NoError"}]
```

### **3. Verificação**
- ✅ Abra `http://localhost:5173/chargers/CB-TESTE-COMPLETO`
- ✅ Observe os dados aparecendo em tempo real
- ✅ Verifique o histórico de eventos

---

## 🎯 URLs Importantes

- **Dashboard**: `http://localhost:5173/`
- **API**: `http://localhost:3000/`
- **WebSocket OCPP**: `ws://localhost:3000/ocpp/CentralSystemService/<CHARGE_BOX_ID>`
- **SSE Stream**: `http://localhost:3000/v1/stream`

---

**🚀 Agora você pode testar completamente a integração entre simuladores OCPP externos e seu CSMS!**