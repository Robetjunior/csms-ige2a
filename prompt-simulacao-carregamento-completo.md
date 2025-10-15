# 🔋 Prompt para Simulação Completa de Carregamento OCPP

## 🎯 Objetivo
Simular um fluxo perfeito de carregamento de veículo elétrico com início, meio e fim, enviando todos os dados que aparecem na interface real do dashboard, incluindo métricas em tempo real como mostrado na imagem.

## 📊 Dados da Interface a Serem Simulados

### Status e Progresso
- **Status**: "Charging in progress" → "Charging completed"
- **Progresso**: 0% → 100% (barra circular)
- **Botão**: "Stop Charging" (ativo durante carregamento)

### Métricas em Tempo Real
- **Power**: 0 kW → 50 kW → 0 kW
- **Voltage**: 0 V → 230 V → 0 V  
- **Current**: 0 A → 217 A → 0 A
- **Duration**: 0 min → tempo crescente
- **Total Amount**: 0 → valor crescente
- **Energy**: 0 KWh → energia acumulada
- **Start Time**: timestamp do início
- **Unit Price**: preço por kWh
- **Temperature**: temperatura do conector

## 🚀 Script de Simulação Completa

### Configuração Inicial
```bash
# Configurar variáveis
CHARGE_BOX_ID="CB-SIMULATOR-01"
CONNECTOR_ID=1
TRANSACTION_ID=1001
USER_ID="USER123"
API_URL="http://localhost:3000/v1/ocpp/events"
```

### Fase 1: Preparação e Início (0-30 segundos)

#### 1.1 Status Inicial - Disponível
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "status": "Available",
      "errorCode": "NoError",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

#### 1.2 Preparando para Carregamento
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "status": "Preparing",
      "errorCode": "NoError",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

#### 1.3 Início da Transação
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StartTransaction",
    "transactionId": '$TRANSACTION_ID',
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "idTag": "'$USER_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "meterStart": 1000,
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

#### 1.4 Status Carregando
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "status": "Charging",
      "errorCode": "NoError",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

### Fase 2: Carregamento Ativo (30 segundos - 5 minutos)

#### 2.1 Telemetria Inicial (Rampa de Subida)
```bash
# Potência crescendo gradualmente: 5kW → 15kW → 30kW → 50kW
for power in 5000 10000 15000 25000 35000 45000 50000; do
  voltage=$((220 + RANDOM % 20))  # 220-240V
  current=$((power / voltage))
  energy=$((1000 + power / 1000 * 2))  # Energia acumulada
  temp=$((25 + power / 2000))  # Temperatura baseada na potência
  
  curl -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d '{
      "type": "MeterValues",
      "transactionId": '$TRANSACTION_ID',
      "chargeBoxId": "'$CHARGE_BOX_ID'",
      "payload": {
        "connectorId": '$CONNECTOR_ID',
        "meterValue": [{
          "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
          "sampledValue": [
            {"value": "'$energy'", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
            {"value": "'$power'", "measurand": "Power.Active.Import", "unit": "W"},
            {"value": "'$voltage'", "measurand": "Voltage", "unit": "V"},
            {"value": "'$current'", "measurand": "Current.Import", "unit": "A"},
            {"value": "'$temp'", "measurand": "Temperature", "unit": "Celsius"}
          ]
        }]
      }
    }'
  
  sleep 10  # Aguardar 10 segundos entre medições
done
```

#### 2.2 Telemetria Estável (Potência Máxima)
```bash
# Manter potência estável por 3 minutos
for i in {1..18}; do  # 18 x 10s = 3 minutos
  power=50000
  voltage=$((230 + RANDOM % 10 - 5))  # 225-235V (estável)
  current=$((power / voltage))
  energy=$((1000 + 50 * i))  # Energia crescendo linearmente
  temp=$((45 + RANDOM % 10 - 5))  # 40-50°C (estável)
  
  curl -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d '{
      "type": "MeterValues",
      "transactionId": '$TRANSACTION_ID',
      "chargeBoxId": "'$CHARGE_BOX_ID'",
      "payload": {
        "connectorId": '$CONNECTOR_ID',
        "meterValue": [{
          "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
          "sampledValue": [
            {"value": "'$energy'", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
            {"value": "'$power'", "measurand": "Power.Active.Import", "unit": "W"},
            {"value": "'$voltage'", "measurand": "Voltage", "unit": "V"},
            {"value": "'$current'", "measurand": "Current.Import", "unit": "A"},
            {"value": "'$temp'", "measurand": "Temperature", "unit": "Celsius"},
            {"value": "$(((i * 100) / 18))", "measurand": "SoC", "unit": "Percent"}
          ]
        }]
      }
    }'
  
  sleep 10
done
```

### Fase 3: Finalização (Últimos 30 segundos)

#### 3.1 Telemetria de Finalização (Rampa de Descida)
```bash
# Potência diminuindo gradualmente: 50kW → 30kW → 15kW → 5kW → 0kW
for power in 45000 35000 25000 15000 10000 5000 1000 0; do
  voltage=$((230 + RANDOM % 10 - 5))
  current=$((power / (voltage + 1)))  # +1 para evitar divisão por zero
  energy=2000  # Energia final
  temp=$((50 - (50000 - power) / 2000))  # Temperatura diminuindo
  
  curl -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d '{
      "type": "MeterValues",
      "transactionId": '$TRANSACTION_ID',
      "chargeBoxId": "'$CHARGE_BOX_ID'",
      "payload": {
        "connectorId": '$CONNECTOR_ID',
        "meterValue": [{
          "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
          "sampledValue": [
            {"value": "'$energy'", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
            {"value": "'$power'", "measurand": "Power.Active.Import", "unit": "W"},
            {"value": "'$voltage'", "measurand": "Voltage", "unit": "V"},
            {"value": "'$current'", "measurand": "Current.Import", "unit": "A"},
            {"value": "'$temp'", "measurand": "Temperature", "unit": "Celsius"},
            {"value": "100", "measurand": "SoC", "unit": "Percent"}
          ]
        }]
      }
    }'
  
  sleep 3
done
```

#### 3.2 Finalizar Transação
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StopTransaction",
    "transactionId": '$TRANSACTION_ID',
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "reason": "Local",
    "payload": {
      "meterStop": 2000,
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

#### 3.3 Status Final - Finalizando
```bash
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "status": "Finishing",
      "errorCode": "NoError",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

#### 3.4 Status Final - Disponível
```bash
sleep 5
curl -X POST $API_URL \
  -H "Content-Type: application/json" \
  -d '{
    "type": "StatusNotification",
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "status": "Available",
      "errorCode": "NoError",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'"
    }
  }'
```

## 🎬 Script Automatizado Completo

### Salvar como `simulacao-carregamento-completo.sh`

```bash
#!/bin/bash

# Configurações
CHARGE_BOX_ID="CB-SIMULATOR-01"
CONNECTOR_ID=1
TRANSACTION_ID=$((RANDOM + 1000))
USER_ID="USER123"
API_URL="http://localhost:3000/v1/ocpp/events"

echo "🔋 Iniciando simulação de carregamento completo..."
echo "📊 Charge Box ID: $CHARGE_BOX_ID"
echo "🔌 Connector ID: $CONNECTOR_ID"
echo "🆔 Transaction ID: $TRANSACTION_ID"
echo ""

# Função para enviar evento OCPP
send_ocpp_event() {
  local event_type=$1
  local payload=$2
  
  curl -s -X POST $API_URL \
    -H "Content-Type: application/json" \
    -d "$payload" > /dev/null
  
  echo "✅ Enviado: $event_type"
}

# Fase 1: Preparação
echo "🚀 Fase 1: Preparação e Início"
send_ocpp_event "StatusNotification" '{
  "type": "StatusNotification",
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "payload": {
    "connectorId": '$CONNECTOR_ID',
    "status": "Available",
    "errorCode": "NoError"
  }
}'

sleep 2

send_ocpp_event "StatusNotification" '{
  "type": "StatusNotification",
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "payload": {
    "connectorId": '$CONNECTOR_ID',
    "status": "Preparing",
    "errorCode": "NoError"
  }
}'

sleep 3

send_ocpp_event "StartTransaction" '{
  "type": "StartTransaction",
  "transactionId": '$TRANSACTION_ID',
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "idTag": "'$USER_ID'",
  "payload": {
    "connectorId": '$CONNECTOR_ID',
    "meterStart": 1000
  }
}'

sleep 2

send_ocpp_event "StatusNotification" '{
  "type": "StatusNotification",
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "payload": {
    "connectorId": '$CONNECTOR_ID',
    "status": "Charging",
    "errorCode": "NoError"
  }
}'

# Fase 2: Carregamento Ativo
echo "⚡ Fase 2: Carregamento Ativo"

# Rampa de subida
echo "📈 Rampa de subida de potência..."
for power in 5000 10000 15000 25000 35000 45000 50000; do
  voltage=$((220 + RANDOM % 20))
  current=$((power / voltage))
  energy=$((1000 + power / 1000 * 2))
  temp=$((25 + power / 2000))
  
  send_ocpp_event "MeterValues" '{
    "type": "MeterValues",
    "transactionId": '$TRANSACTION_ID',
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "meterValue": [{
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
        "sampledValue": [
          {"value": "'$energy'", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
          {"value": "'$power'", "measurand": "Power.Active.Import", "unit": "W"},
          {"value": "'$voltage'", "measurand": "Voltage", "unit": "V"},
          {"value": "'$current'", "measurand": "Current.Import", "unit": "A"},
          {"value": "'$temp'", "measurand": "Temperature", "unit": "Celsius"}
        ]
      }]
    }
  }'
  
  sleep 5
done

# Potência estável
echo "🔄 Mantendo potência estável..."
for i in {1..10}; do
  power=50000
  voltage=$((230 + RANDOM % 10 - 5))
  current=$((power / voltage))
  energy=$((1000 + 50 * i))
  temp=$((45 + RANDOM % 10 - 5))
  soc=$(((i * 100) / 10))
  
  send_ocpp_event "MeterValues" '{
    "type": "MeterValues",
    "transactionId": '$TRANSACTION_ID',
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "meterValue": [{
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
        "sampledValue": [
          {"value": "'$energy'", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
          {"value": "'$power'", "measurand": "Power.Active.Import", "unit": "W"},
          {"value": "'$voltage'", "measurand": "Voltage", "unit": "V"},
          {"value": "'$current'", "measurand": "Current.Import", "unit": "A"},
          {"value": "'$temp'", "measurand": "Temperature", "unit": "Celsius"},
          {"value": "'$soc'", "measurand": "SoC", "unit": "Percent"}
        ]
      }]
    }
  }'
  
  sleep 5
done

# Fase 3: Finalização
echo "🏁 Fase 3: Finalização"

# Rampa de descida
echo "📉 Rampa de descida de potência..."
for power in 45000 35000 25000 15000 10000 5000 1000 0; do
  voltage=$((230 + RANDOM % 10 - 5))
  current=$((power / (voltage + 1)))
  energy=2000
  temp=$((50 - (50000 - power) / 2000))
  
  send_ocpp_event "MeterValues" '{
    "type": "MeterValues",
    "transactionId": '$TRANSACTION_ID',
    "chargeBoxId": "'$CHARGE_BOX_ID'",
    "payload": {
      "connectorId": '$CONNECTOR_ID',
      "meterValue": [{
        "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)'",
        "sampledValue": [
          {"value": "'$energy'", "measurand": "Energy.Active.Import.Register", "unit": "Wh"},
          {"value": "'$power'", "measurand": "Power.Active.Import", "unit": "W"},
          {"value": "'$voltage'", "measurand": "Voltage", "unit": "V"},
          {"value": "'$current'", "measurand": "Current.Import", "unit": "A"},
          {"value": "'$temp'", "measurand": "Temperature", "unit": "Celsius"},
          {"value": "100", "measurand": "SoC", "unit": "Percent"}
        ]
      }]
    }
  }'
  
  sleep 3
done

# Finalizar transação
send_ocpp_event "StopTransaction" '{
  "type": "StopTransaction",
  "transactionId": '$TRANSACTION_ID',
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "reason": "Local",
  "payload": {
    "meterStop": 2000
  }
}'

sleep 2

send_ocpp_event "StatusNotification" '{
  "type": "StatusNotification",
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "payload": {
    "connectorId": '$CONNECTOR_ID',
    "status": "Finishing",
    "errorCode": "NoError"
  }
}'

sleep 3

send_ocpp_event "StatusNotification" '{
  "type": "StatusNotification",
  "chargeBoxId": "'$CHARGE_BOX_ID'",
  "payload": {
    "connectorId": '$CONNECTOR_ID',
    "status": "Available",
    "errorCode": "NoError"
  }
}'

echo ""
echo "🎉 Simulação de carregamento completa!"
echo "📊 Dados enviados:"
echo "   - Energia total: 1 kWh"
echo "   - Potência máxima: 50 kW"
echo "   - Duração: ~5 minutos"
echo "   - Status final: Available"
echo ""
echo "🌐 Verifique os resultados em: http://localhost:5173/"
```

## 🚀 Como Usar

### 1. Salvar o Script
```bash
# Salvar o script
nano simulacao-carregamento-completo.sh

# Dar permissão de execução
chmod +x simulacao-carregamento-completo.sh
```

### 2. Executar a Simulação
```bash
# Executar o script
./simulacao-carregamento-completo.sh
```

### 3. Monitorar no Dashboard
- Abrir: `http://localhost:5173/`
- Navegar para a página do carregador: `http://localhost:5173/charger/CB-SIMULATOR-01`
- Observar os dados em tempo real

## 📈 Resultados Esperados

### Na Interface do Dashboard:
1. **Status**: "No order in progress" → "Charging in progress" → "Charging completed"
2. **Progresso**: 0% → 100%
3. **Power**: 0 kW → 50 kW → 0 kW
4. **Voltage**: 0 V → 230 V → 0 V
5. **Current**: 0 A → 217 A → 0 A
6. **Energy**: 0 KWh → 1 KWh
7. **Temperature**: 0°C → 50°C → 25°C
8. **Duration**: Tempo crescente durante o carregamento

### Eventos SSE Gerados:
- `status-change`: Mudanças de status do conector
- `session-start`: Início da sessão de carregamento
- `session-end`: Fim da sessão de carregamento
- `telemetry-updated`: Dados de telemetria em tempo real

## 🎯 Personalização

### Ajustar Duração
- Modificar os valores de `sleep` no script
- Alterar o número de iterações nos loops

### Ajustar Potência
- Modificar os valores no array `power`
- Ajustar a rampa de subida/descida

### Adicionar Mais Métricas
- Incluir novos `measurand` nos `MeterValues`
- Exemplos: `Frequency`, `Power.Reactive.Import`, `Energy.Reactive.Import.Register`

---

**✨ Este prompt garante uma simulação realística e completa de carregamento OCPP com todos os dados visíveis na interface do dashboard!**