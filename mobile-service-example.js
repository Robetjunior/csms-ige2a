/**
 * Exemplo de Serviço para App Mobile - Telemetria em Tempo Real
 * 
 * Para usar no seu app React Native/Expo:
 * 1. Configure EXPO_PUBLIC_API_BASE_URL=http://localhost:3000 no .env
 * 2. Use adb reverse tcp:3000 tcp:3000 para desenvolvimento USB
 * 3. Adapte este código para TypeScript se necessário
 */

class ChargingTelemetryService {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
    this.pollingInterval = null;
    this.isPolling = false;
    this.listeners = new Set();
    this.currentData = null;
    this.errorCount = 0;
    this.maxErrors = 3;
  }

  /**
   * Inicia o polling de telemetria para um carregador específico
   * @param {string} chargeBoxId - ID do carregador (ex: 'DRBAKANA-TEST-01')
   * @param {number} intervalMs - Intervalo em ms (padrão: 5000 = 5s)
   */
  startPolling(chargeBoxId, intervalMs = 5000) {
    if (this.isPolling) {
      console.warn('[TelemetryService] Polling já está ativo');
      return;
    }

    console.log(`[TelemetryService] Iniciando polling para ${chargeBoxId} a cada ${intervalMs}ms`);
    this.isPolling = true;
    this.errorCount = 0;

    // Primeira busca imediata
    this.fetchTelemetry(chargeBoxId);

    // Configurar polling
    this.pollingInterval = setInterval(() => {
      this.fetchTelemetry(chargeBoxId);
    }, intervalMs);
  }

  /**
   * Para o polling
   */
  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isPolling = false;
    console.log('[TelemetryService] Polling parado');
  }

  /**
   * Busca telemetria do carregador
   * @param {string} chargeBoxId 
   */
  async fetchTelemetry(chargeBoxId) {
    try {
      const response = await fetch(`${this.baseUrl}/charge/${chargeBoxId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        // Timeout de 10s
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      this.currentData = data;
      this.errorCount = 0; // Reset contador de erros

      // Notificar listeners
      this.notifyListeners(data);

      console.log(`[TelemetryService] Dados recebidos:`, {
        status: data.status,
        charging: data.charging,
        kwh: data.telemetry?.kwh || 0,
        powerKw: data.telemetry?.powerKw || 0
      });

    } catch (error) {
      this.errorCount++;
      console.error(`[TelemetryService] Erro (${this.errorCount}/${this.maxErrors}):`, error.message);

      // Se muitos erros consecutivos, parar polling e notificar
      if (this.errorCount >= this.maxErrors) {
        console.error('[TelemetryService] Muitos erros consecutivos, parando polling');
        this.stopPolling();
        this.notifyListeners({ error: 'connection_failed', message: error.message });
      }
    }
  }

  /**
   * Busca apenas o status (mais leve)
   * @param {string} chargeBoxId 
   */
  async fetchStatus(chargeBoxId) {
    try {
      const response = await fetch(`${this.baseUrl}/charge/${chargeBoxId}/status`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[TelemetryService] Erro ao buscar status:', error.message);
      throw error;
    }
  }

  /**
   * Adiciona listener para mudanças nos dados
   * @param {Function} callback - Função chamada quando dados mudam
   */
  addListener(callback) {
    this.listeners.add(callback);
    
    // Se já tem dados, notificar imediatamente
    if (this.currentData) {
      callback(this.currentData);
    }
  }

  /**
   * Remove listener
   * @param {Function} callback 
   */
  removeListener(callback) {
    this.listeners.delete(callback);
  }

  /**
   * Notifica todos os listeners
   * @param {Object} data 
   */
  notifyListeners(data) {
    this.listeners.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error('[TelemetryService] Erro no listener:', error);
      }
    });
  }

  /**
   * Retorna os dados atuais (cache)
   */
  getCurrentData() {
    return this.currentData;
  }

  /**
   * Verifica se está fazendo polling
   */
  isActive() {
    return this.isPolling;
  }
}

// Exemplo de uso no React Native/Expo
const ExampleUsage = {
  // 1. Criar instância do serviço
  service: new ChargingTelemetryService(),

  // 2. Componente React exemplo
  ChargingScreen: function({ chargeBoxId }) {
    const [telemetryData, setTelemetryData] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
      // Listener para atualizações
      const handleUpdate = (data) => {
        setTelemetryData(data);
        setIsLoading(false);
      };

      // Adicionar listener
      this.service.addListener(handleUpdate);

      // Iniciar polling
      this.service.startPolling(chargeBoxId, 5000); // 5s

      // Cleanup
      return () => {
        this.service.removeListener(handleUpdate);
        this.service.stopPolling();
      };
    }, [chargeBoxId]);

    if (isLoading) {
      return <Text>Carregando telemetria...</Text>;
    }

    if (telemetryData?.error) {
      return <Text>Erro: {telemetryData.message}</Text>;
    }

    return (
      <View>
        <Text>Status: {telemetryData?.status}</Text>
        <Text>Carregando: {telemetryData?.charging ? 'Sim' : 'Não'}</Text>
        
        {telemetryData?.charging && telemetryData?.telemetry && (
          <View>
            <Text>Energia: {telemetryData.telemetry.kwh} kWh</Text>
            <Text>Potência: {telemetryData.telemetry.powerKw} kW</Text>
            <Text>Tensão: {telemetryData.telemetry.voltageV} V</Text>
            <Text>Corrente: {telemetryData.telemetry.currentA} A</Text>
            {telemetryData.telemetry.temperatureC && (
              <Text>Temperatura: {telemetryData.telemetry.temperatureC}°C</Text>
            )}
            {telemetryData.telemetry.socPercent && (
              <Text>SoC: {telemetryData.telemetry.socPercent}%</Text>
            )}
          </View>
        )}
      </View>
    );
  }
};

// Exportar para uso
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChargingTelemetryService, ExampleUsage };
}

// Para uso global no browser/app
if (typeof window !== 'undefined') {
  window.ChargingTelemetryService = ChargingTelemetryService;
}

console.log('✅ ChargingTelemetryService carregado. Exemplo de uso disponível.');