http://localhost:3000/v1/stream# Sistema de Telemetria em Tempo Real

## Visão Geral

Este sistema implementa telemetria em tempo real para estações de carregamento OCPP, fornecendo dados de carregamento via Server-Sent Events (SSE) com throttling inteligente, validação robusta e monitoramento completo.

## Arquitetura

### Componentes Principais

1. **Stream SSE** (`routes/stream.ts`)
   - Endpoint `/v1/stream` estendido com eventos `telemetry-updated`
   - Suporte a filtros por tipo de evento
   - Gerenciamento de conexões SSE

2. **Telemetry Manager** (`services/telemetry-manager.ts`)
   - Gerenciamento de sessões ativas de carregamento
   - Processamento de mensagens OCPP MeterValues
   - Throttling inteligente (7s padrão)
   - Extração e validação de dados de telemetria

3. **Configuração** (`config/telemetry.ts`)
   - Configurações centralizadas via variáveis de ambiente
   - Validação de limites de dados (potência, tensão, corrente, etc.)
   - Configurações de throttling e logging

4. **Logger** (`utils/telemetry-logger.ts`)
   - Sistema de logging especializado para telemetria
   - Métricas de performance e estatísticas
   - Logs estruturados com categorização

5. **API de Status** (`routes/telemetry-status.ts`)
   - Endpoint `/v1/telemetry/status` para monitoramento
   - Métricas em tempo real
   - Logs recentes e health check

## Fluxo de Dados

```
OCPP MeterValues → CSMS → TelemetryManager → Validação → SSE Event
                     ↓
                 Database → Logs & Metrics
```

## Configuração

### Variáveis de Ambiente

```env
# Throttling
TELEMETRY_THROTTLE_MS=7000          # Intervalo mínimo entre eventos (ms)
TELEMETRY_MIN_UPDATE_MS=5000        # Intervalo mínimo de atualização (ms)

# Limites de Sessões
TELEMETRY_MAX_SESSIONS=1000         # Máximo de sessões em memória

# Validação de Dados
TELEMETRY_MAX_POWER_KW=350          # Potência máxima (kW)
TELEMETRY_MAX_VOLTAGE_V=1000        # Tensão máxima (V)
TELEMETRY_MAX_CURRENT_A=500         # Corrente máxima (A)
TELEMETRY_MAX_TEMP_C=80             # Temperatura máxima (°C)
TELEMETRY_MIN_TEMP_C=-40            # Temperatura mínima (°C)

# Logging
TELEMETRY_DETAILED_LOGS=false       # Logs detalhados
TELEMETRY_LOG_INVALID=true          # Log de dados inválidos

# Rate Limiting
TELEMETRY_RATE_LIMITING=false       # Ativar rate limiting
TELEMETRY_RATE_LIMIT_RPM=60         # Requests por minuto
```

## Uso

### Conectar ao Stream SSE

```javascript
const eventSource = new EventSource('/v1/stream?types=telemetry-updated');

eventSource.addEventListener('telemetry-updated', (event) => {
  const data = JSON.parse(event.data);
  console.log('Telemetria:', data);
});
```

### Estrutura do Evento de Telemetria

```json
{
  "chargeBoxId": "CHARGER001",
  "transactionId": 123,
  "telemetry": {
    "power_kw": 7.5,
    "energy_kwh": 15.2,
    "voltage_v": 230,
    "current_a": 32.6,
    "soc_percent": 65,
    "temperature_c": 25,
    "duration_seconds": 1800
  },
  "updatedAt": "2025-10-03T19:26:25.297Z"
}
```

### Monitoramento

```bash
# Status do sistema
GET /v1/telemetry/status

# Logs recentes
GET /v1/telemetry/logs?limit=50&level=error

# Health check
GET /v1/telemetry/health

# Reset métricas
POST /v1/telemetry/reset-metrics
```

## Integração OCPP

### StartTransaction
- Registra nova sessão ativa
- Inicializa controle de throttling

### MeterValues
- Extrai dados de telemetria dos sampledValues
- Aplica throttling (7s padrão)
- Valida dados extraídos
- Emite evento SSE se válido

### StopTransaction
- Remove sessão ativa
- Limpa dados de throttling

## Validação de Dados

O sistema valida automaticamente:
- **Potência**: 0-350 kW
- **Tensão**: 0-1000 V
- **Corrente**: 0-500 A
- **Temperatura**: -40°C a 80°C
- **SoC**: 0-100%
- **Energia**: Valores positivos

Dados inválidos são filtrados e logados para auditoria.

## Throttling

- **Intervalo padrão**: 7 segundos entre eventos
- **Mínimo configurável**: 5 segundos
- **Por transação**: Cada sessão tem seu próprio controle
- **Eventos throttled**: Logados para métricas

## Monitoramento e Métricas

### Métricas Disponíveis
- Total de sessões processadas
- Sessões ativas
- MeterValues processados
- Eventos de telemetria enviados
- Erros de validação
- Eventos throttled
- Tempo médio de processamento

### Logs Estruturados
- Início/fim de sessões
- Processamento de MeterValues
- Eventos de telemetria enviados
- Erros de validação
- Eventos throttled

## Teste

Execute o teste integrado:

```bash
npx ts-node src/test-telemetry.ts
```

O teste simula:
1. Início de sessão
2. Processamento de MeterValues
3. Validação de dados
4. Verificação de métricas
5. Parada de sessão

## Filtros por Cliente

O sistema suporta filtros por cliente/estação:

```typescript
// Adicionar filtro
telemetryManager.addClientFilter('client123', 'CHARGER001');

// Verificar autorização
const authorized = telemetryManager.isClientAuthorized('client123', 'CHARGER001');

// Remover filtro
telemetryManager.removeClientFilter('client123', 'CHARGER001');
```

## Performance

- **Throttling**: Previne spam de eventos
- **Validação eficiente**: Filtros rápidos por tipo de dado
- **Memória otimizada**: Limpeza automática de sessões antigas
- **Logs estruturados**: Baixo overhead de logging

## Segurança

- Validação rigorosa de dados de entrada
- Filtros por cliente/estação
- Rate limiting configurável
- Logs de auditoria completos
- Sem exposição de dados sensíveis

## Troubleshooting

### Eventos não aparecem
1. Verificar se a sessão está ativa
2. Confirmar throttling (7s entre eventos)
3. Validar dados de MeterValues
4. Verificar logs de erro

### Performance degradada
1. Verificar número de sessões ativas
2. Ajustar TELEMETRY_THROTTLE_MS
3. Revisar logs de validação
4. Monitorar métricas de performance

### Dados inválidos
1. Verificar limites de validação
2. Confirmar formato de MeterValues
3. Revisar logs de validação
4. Ajustar configurações se necessário