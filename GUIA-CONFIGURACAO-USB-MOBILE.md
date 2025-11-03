# 📱 Guia de Configuração USB para App Mobile

## 🎯 Objetivo
Configurar o backend para desenvolvimento USB, permitindo que o app mobile acesse telemetria em tempo real via `localhost`.

---

## 🔧 Configuração do Backend

### 1. **Endpoints Criados**
- `GET /charge/:chargeBoxId` - Telemetria completa
- `GET /charge/:chargeBoxId/status` - Status simplificado

### 2. **Características**
- ✅ **Sem autenticação** (público para facilitar uso mobile)
- ✅ **CORS configurado** para localhost
- ✅ **Resposta simplificada** (formato mobile-friendly)
- ✅ **Tratamento de erros** robusto
- ✅ **Timeout configurado** (10s)

---

## 📱 Configuração do App Mobile

### 1. **Variáveis de Ambiente**
```bash
# No arquivo .env do projeto mobile
EXPO_PUBLIC_API_BASE_URL=http://localhost:3000
```

### 2. **Configuração ADB (Desenvolvimento USB)**
```bash
# Redirecionar porta do dispositivo para o computador
adb reverse tcp:3000 tcp:3000

# Verificar se funcionou
adb reverse --list
```

### 3. **Verificar Conectividade**
```bash
# No dispositivo/emulador, testar:
curl http://localhost:3000/health
# Deve retornar: {"ok": true}
```

---

## 🚀 Implementação no App

### 1. **Instalar Dependências** (se necessário)
```bash
npm install @react-native-async-storage/async-storage
# ou
yarn add @react-native-async-storage/async-storage
```

### 2. **Serviço de Telemetria**
Copie o código do arquivo `mobile-service-example.js` e adapte para TypeScript:

```typescript
// services/ChargingTelemetryService.ts
export class ChargingTelemetryService {
  private baseUrl: string;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling: boolean = false;
  private listeners: Set<(data: any) => void> = new Set();
  
  constructor(baseUrl: string = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
  }
  
  // ... resto da implementação
}
```

### 3. **Hook React Personalizado**
```typescript
// hooks/useChargingTelemetry.ts
import { useState, useEffect } from 'react';
import { ChargingTelemetryService } from '../services/ChargingTelemetryService';

export function useChargingTelemetry(chargeBoxId: string) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  
  useEffect(() => {
    const service = new ChargingTelemetryService();
    
    const handleUpdate = (telemetryData: any) => {
      if (telemetryData.error) {
        setError(telemetryData.message);
      } else {
        setData(telemetryData);
        setError(null);
      }
      setLoading(false);
    };
    
    service.addListener(handleUpdate);
    service.startPolling(chargeBoxId, 5000); // 5s
    
    return () => {
      service.removeListener(handleUpdate);
      service.stopPolling();
    };
  }, [chargeBoxId]);
  
  return { data, loading, error };
}
```

### 4. **Componente de Exemplo**
```typescript
// screens/ChargingScreen.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useChargingTelemetry } from '../hooks/useChargingTelemetry';

export function ChargingScreen({ route }) {
  const { chargeBoxId } = route.params;
  const { data, loading, error } = useChargingTelemetry(chargeBoxId);
  
  if (loading) {
    return (
      <View style={styles.container}>
        <Text>Carregando telemetria...</Text>
      </View>
    );
  }
  
  if (error) {
    return (
      <View style={styles.container}>
        <Text style={styles.error}>Erro: {error}</Text>
      </View>
    );
  }
  
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Carregador {chargeBoxId}</Text>
      <Text>Status: {data?.status}</Text>
      <Text>Carregando: {data?.charging ? 'Sim' : 'Não'}</Text>
      
      {data?.charging && data?.telemetry && (
        <View style={styles.telemetry}>
          <Text>⚡ Energia: {data.telemetry.kwh} kWh</Text>
          <Text>🔋 Potência: {data.telemetry.powerKw} kW</Text>
          <Text>⚡ Tensão: {data.telemetry.voltageV} V</Text>
          <Text>🔌 Corrente: {data.telemetry.currentA} A</Text>
          {data.telemetry.temperatureC && (
            <Text>🌡️ Temperatura: {data.telemetry.temperatureC}°C</Text>
          )}
          {data.telemetry.socPercent && (
            <Text>📊 SoC: {data.telemetry.socPercent}%</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  telemetry: {
    marginTop: 20,
    padding: 15,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
  },
  error: {
    color: 'red',
    fontSize: 16,
  },
});
```

---

## 🧪 Testes

### 1. **Testar Backend**
```bash
# Servidor rodando
curl http://localhost:3000/health

# Telemetria completa
curl http://localhost:3000/charge/DRBAKANA-TEST-01

# Status simplificado
curl http://localhost:3000/charge/DRBAKANA-TEST-01/status
```

### 2. **Testar no App**
1. Conectar dispositivo via USB
2. Executar `adb reverse tcp:3000 tcp:3000`
3. Abrir app e navegar para tela de carregamento
4. Verificar se dados aparecem em tempo real

---

## 📊 Formato das Respostas

### **Carregador Ativo**
```json
{
  "status": "charging",
  "charging": true,
  "chargeBoxId": "DRBAKANA-TEST-01",
  "session": {
    "transactionId": 758715753,
    "startedAt": "2025-09-24T12:09:14.072+00:00",
    "durationSeconds": 3208682,
    "idTag": "DEMO-123456"
  },
  "telemetry": {
    "kwh": 1.234,
    "powerKw": 6.8,
    "voltageV": 220.5,
    "currentA": 31.2,
    "temperatureC": 25.5,
    "socPercent": 75
  }
}
```

### **Carregador Disponível**
```json
{
  "status": "available",
  "charging": false,
  "chargeBoxId": "CB-TESTE",
  "session": null,
  "telemetry": null
}
```

---

## 🔧 Troubleshooting

### **Problema: App não conecta**
```bash
# Verificar ADB
adb devices

# Reconfigurar reverse
adb reverse --remove tcp:3000
adb reverse tcp:3000 tcp:3000
```

### **Problema: CORS Error**
- ✅ CORS já configurado para localhost
- Verificar se `baseUrl` está correto no app

### **Problema: Timeout**
- Verificar se backend está rodando
- Aumentar timeout no serviço (padrão: 10s)

### **Problema: Muitos erros**
- Serviço para automaticamente após 3 erros consecutivos
- Verificar logs do backend
- Reiniciar polling manualmente

---

## 🎯 Próximos Passos

1. **Implementar no projeto mobile** usando os exemplos acima
2. **Testar com diferentes carregadores** (ativo/disponível)
3. **Adicionar indicadores visuais** (loading, erro, sucesso)
4. **Configurar notificações** para mudanças de status
5. **Otimizar polling** (reduzir frequência quando inativo)

---

## 📝 Notas Importantes

- **Polling Inteligente**: Considere reduzir frequência quando `charging: false`
- **Gestão de Bateria**: Pausar polling quando app em background
- **Cache Local**: Salvar último estado para exibição offline
- **Retry Logic**: Implementado automaticamente no serviço
- **Segurança**: API Key protegida no backend, não exposta ao app

**✅ Configuração completa para desenvolvimento USB!**