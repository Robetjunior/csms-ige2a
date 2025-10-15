# 🔌 Simulador OCPP Configurável

Este simulador permite testar o CSMS com diferentes configurações de Charge Points de forma interativa.

## 🚀 Como Usar

### Modo Interativo (Recomendado)
```bash
node simulador-ocpp-configuravel.js
```

O simulador irá solicitar as seguintes configurações:
- **ID do Charge Point**: Identificador único (ex: TESTE-001)
- **Host do CSMS**: Endereço do servidor (padrão: localhost)
- **Porta do CSMS**: Porta do servidor (padrão: 3000)
- **Fabricante**: Nome do fabricante (padrão: SimuladorOCPP)
- **Modelo**: Modelo do equipamento (padrão: Teste-v1.0)
- **Versão Firmware**: Versão do firmware (padrão: 1.0.0)
- **Intervalo Telemetria**: Frequência de envio em ms (padrão: 5000)

### Modo Rápido
```bash
node simulador-ocpp-configuravel.js [CHARGE_POINT_ID] [HOST] [PORTA]
```

Exemplos:
```bash
# Simulador local básico
node simulador-ocpp-configuravel.js TESTE-001

# Simulador com host customizado
node simulador-ocpp-configuravel.js TESTE-002 192.168.1.100

# Simulador com host e porta customizados
node simulador-ocpp-configuravel.js TESTE-003 192.168.1.100 8080
```

## 📋 Funcionalidades

### ✅ Comandos Suportados
- **RemoteStartTransaction**: Inicia carregamento
- **RemoteStopTransaction**: Para carregamento
- **Reset**: Reinicia o simulador

### 📊 Telemetria Automática
- **Potência**: 1-11kW (aleatório)
- **Tensão**: 220-240V (aleatório)
- **Corrente**: Calculada automaticamente
- **Frequência**: Configurável (padrão: 5 segundos)

### 🔄 Estados do Charge Point
- **Available**: Disponível para carregamento
- **Charging**: Carregando ativamente
- **Faulted**: Em caso de erro

## 🧪 Testando com a API

### 1. Iniciar Carregamento
```bash
curl -X POST http://localhost:3000/v1/commands/remoteStart \
  -H "X-API-Key: minha_chave_super_secreta" \
  -H "Content-Type: application/json" \
  -d '{
    "chargeBoxId": "TESTE-001",
    "connectorId": 1,
    "idTag": "USER123"
  }'
```

### 2. Parar Carregamento
```bash
curl -X POST http://localhost:3000/v1/commands/remoteStop \
  -H "X-API-Key: minha_chave_super_secreta" \
  -H "Content-Type: application/json" \
  -d '{
    "chargeBoxId": "TESTE-001",
    "transactionId": 123456
  }'
```

### 3. Verificar Status
```bash
curl -X GET "http://localhost:3000/v1/chargers/online" \
  -H "X-API-Key: minha_chave_super_secreta"
```

## 📈 Monitoramento

### Dashboard Web
Acesse: `http://localhost:5173/chargers/[CHARGE_POINT_ID]`

Exemplo: `http://localhost:5173/chargers/TESTE-001`

### Stream de Dados em Tempo Real
```bash
curl -X GET "http://localhost:3000/v1/stream?apiKey=minha_chave_super_secreta"
```

## 🔧 Configurações Avançadas

### Personalizar Telemetria
Edite o arquivo `simulador-ocpp-configuravel.js` na função `startMeterValues()`:

```javascript
// Exemplo: Simular carro elétrico pequeno (3.7kW)
const power = Math.floor(Math.random() * 1000) + 3000; // 3-4kW

// Exemplo: Simular carregador rápido DC (50kW)
const power = Math.floor(Math.random() * 10000) + 45000; // 45-55kW
```

### Adicionar Novos Comandos
Implemente novos handlers na função `handleCommand()`:

```javascript
case 'NovoComando':
  this.handleNovoComando(messageId, payload);
  break;
```

## 🐛 Solução de Problemas

### Erro de Conexão
- Verifique se o CSMS está rodando
- Confirme host e porta
- Verifique firewall/antivírus

### Comandos Rejeitados
- Verifique se o Charge Point está no estado correto
- Confirme se a API key está correta
- Verifique logs do CSMS

### Telemetria Não Aparece
- Confirme se o carregamento foi iniciado
- Verifique se o dashboard está na URL correta
- Verifique console do navegador para erros

## 📝 Logs

O simulador exibe logs detalhados:
- 🔌 Conexão estabelecida
- 📤 Mensagens enviadas
- 📨 Mensagens recebidas
- 📊 Dados de telemetria
- ✅ Comandos aceitos
- ❌ Erros e rejeições

## 🔗 Integração

Este simulador é compatível com:
- OCPP 1.6 JSON
- WebSocket Secure (WSS) - configure HTTPS
- Múltiplas instâncias simultâneas
- Ambientes de desenvolvimento e produção