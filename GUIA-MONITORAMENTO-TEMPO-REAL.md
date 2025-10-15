# 📊 Guia de Monitoramento em Tempo Real - CSMS

## 🎯 Objetivo
Este guia mostra como monitorar dados de carregamento em tempo real usando diferentes métodos de visualização e APIs do sistema CSMS.

## 🔧 Métodos de Monitoramento

### 1. 📱 Dashboard Web (Recomendado)
**URL**: http://localhost:5173/

#### Funcionalidades:
- ✅ Lista de carregadores conectados
- ✅ Status em tempo real (Available, Charging, Faulted)
- ✅ Dados de telemetria (Potência, Tensão, Corrente)
- ✅ Histórico de transações
- ✅ Controles de comando (Start/Stop)

#### Como usar:
```bash
# 1. Acesse o dashboard
http://localhost:5173/

# 2. Visualize carregador específico
http://localhost:5173/chargers/[CHARGE_BOX_ID]

# 3. Exemplo com simulador externo
http://localhost:5173/chargers/CB-TESTE-SCRIPT
```

### 2. 🌊 Server-Sent Events (SSE)
**Endpoint**: `http://localhost:3000/v1/stream`

#### Parâmetros:
- `apiKey`: minha_chave_super_secreta
- `types`: heartbeat,meter_values,status_change,transaction

#### Exemplo PowerShell:
```powershell
# Monitorar todos os eventos
Invoke-WebRequest -Uri "http://localhost:3000/v1/stream?apiKey=minha_chave_super_secreta&types=heartbeat,meter_values,status_change,transaction" -Method GET

# Monitorar apenas telemetria
Invoke-WebRequest -Uri "http://localhost:3000/v1/stream?apiKey=minha_chave_super_secreta&types=meter_values" -Method GET
```

#### Exemplo curl:
```bash
# Monitorar eventos em tempo real
curl -N "http://localhost:3000/v1/stream?apiKey=minha_chave_super_secreta&types=heartbeat,meter_values,status_change,transaction"
```

### 3. 🔍 API REST para Consultas
**Base URL**: `http://localhost:3000/v1/`

#### Endpoints principais:
```bash
# Listar carregadores
GET /v1/chargers
Headers: X-API-Key: minha_chave_super_secreta

# Dados de carregador específico
GET /v1/chargers/[CHARGE_BOX_ID]
Headers: X-API-Key: minha_chave_super_secreta

# Eventos recentes
GET /v1/events?charge_box_id=[CHARGE_BOX_ID]&limit=10
Headers: X-API-Key: minha_chave_super_secreta

# Transações ativas
GET /v1/transactions?status=active
Headers: X-API-Key: minha_chave_super_secreta
```

### 4. 📊 Logs do Simulador
Monitore diretamente os logs do simulador para debug:

```bash
# Executar simulador com logs detalhados
node teste-simulador-externo.js [CHARGE_BOX_ID]

# Exemplo
node teste-simulador-externo.js CB-TESTE-SCRIPT
```

## 📈 Dados de Telemetria Disponíveis

### MeterValues (Telemetria)
```json
{
  "timestamp": "2024-01-08T22:59:32.677Z",
  "sampledValue": [
    {
      "value": "8376",
      "measurand": "Power.Active.Import",
      "unit": "W"
    },
    {
      "value": "226.7",
      "measurand": "Voltage",
      "unit": "V"
    },
    {
      "value": "36.9",
      "measurand": "Current.Import",
      "unit": "A"
    },
    {
      "value": "25.5",
      "measurand": "Temperature",
      "unit": "Celsius"
    },
    {
      "value": "1250.5",
      "measurand": "Energy.Active.Import.Register",
      "unit": "Wh"
    },
    {
      "value": "75",
      "measurand": "SoC",
      "unit": "Percent"
    }
  ]
}
```

### Status do Carregador
- `Available`: Disponível para carregamento
- `Preparing`: Preparando para iniciar
- `Charging`: Carregando ativamente
- `SuspendedEVSE`: Suspenso pelo carregador
- `SuspendedEV`: Suspenso pelo veículo
- `Finishing`: Finalizando carregamento
- `Reserved`: Reservado
- `Unavailable`: Indisponível
- `Faulted`: Com falha

## 🚀 Cenário de Teste Completo

### Passo 1: Iniciar Sistemas
```bash
# Terminal 1: CSMS
cd services/orchestrator-api
npm run dev

# Terminal 2: Dashboard
cd services/web-dashboard
npm run dev

# Terminal 3: Simulador Externo
node teste-simulador-externo.js CB-TESTE-001
```

### Passo 2: Monitorar via SSE
```powershell
# Terminal 4: Monitoramento SSE
Invoke-WebRequest -Uri "http://localhost:3000/v1/stream?apiKey=minha_chave_super_secreta&types=meter_values,status_change,transaction" -Method GET
```

### Passo 3: Iniciar Carregamento
```powershell
# Via API
Invoke-WebRequest -Uri "http://localhost:3000/v1/commands/remoteStart" -Method POST -Headers @{"Content-Type"="application/json"; "X-API-Key"="minha_chave_super_secreta"} -Body '{"chargeBoxId":"CB-TESTE-001","idTag":"USER123","connectorId":1}'
```

### Passo 4: Observar Dados
1. **Dashboard**: http://localhost:5173/chargers/CB-TESTE-001
2. **SSE Stream**: Dados em tempo real no terminal
3. **Logs Simulador**: Telemetria detalhada
4. **API**: Consultas pontuais

### Passo 5: Parar Carregamento
```powershell
# Obter transactionId do SSE ou logs, depois:
Invoke-WebRequest -Uri "http://localhost:3000/v1/commands/remoteStop" -Method POST -Headers @{"Content-Type"="application/json"; "X-API-Key"="minha_chave_super_secreta"} -Body '{"chargeBoxId":"CB-TESTE-001","transactionId":[TRANSACTION_ID]}'
```

## 🔧 Troubleshooting

### Problema: SSE não conecta
```bash
# Verificar se API está rodando
curl http://localhost:3000/health

# Verificar API key
curl -H "X-API-Key: minha_chave_super_secreta" http://localhost:3000/v1/chargers
```

### Problema: Dashboard não carrega dados
```bash
# Verificar se backend está acessível
curl http://localhost:3000/v1/chargers

# Verificar CORS
curl -H "Origin: http://localhost:5173" http://localhost:3000/v1/chargers
```

### Problema: Simulador não conecta
```bash
# Verificar WebSocket endpoint
wscat -c ws://localhost:3000/ocpp/CentralSystemService/TEST

# Verificar logs do CSMS
# Procurar por mensagens de conexão WebSocket
```

## 📋 Checklist de Monitoramento

- [ ] ✅ CSMS rodando (porta 3000)
- [ ] ✅ Dashboard rodando (porta 5173)
- [ ] ✅ Simulador conectado via WebSocket
- [ ] ✅ SSE stream funcionando
- [ ] ✅ Telemetria sendo enviada (MeterValues)
- [ ] ✅ Comandos remotos funcionando
- [ ] ✅ Status mudando corretamente
- [ ] ✅ Transações sendo registradas

## 🎯 Próximos Passos

1. **Integração com Grafana**: Para dashboards avançados
2. **Alertas**: Configurar notificações para falhas
3. **Métricas**: Implementar coleta de métricas de performance
4. **Logs Centralizados**: ELK Stack para análise de logs
5. **Monitoramento de Infraestrutura**: Prometheus + Grafana

---

**💡 Dica**: Use o dashboard web para visualização geral e SSE para monitoramento detalhado em tempo real durante desenvolvimento e testes.