// src/services/telemetry-manager.ts
import { publish } from '../routes/stream';
import { TelemetryData } from '../routes/stream';
import { sb } from '../../supabase';
import { 
  TELEMETRY_CONFIG, 
  validateTelemetryConfig,
  isValidPower,
  isValidVoltage,
  isValidCurrent,
  isValidTemperature,
  isValidSoC,
  isValidEnergy
} from '../config/telemetry';
import { telemetryLogger } from '../utils/telemetry-logger';

/* ============================ Tipos ============================ */
export interface ActiveSession {
  transactionId: number;
  chargeBoxId: string;
  startedAt: Date;
  lastTelemetryUpdate?: Date;
  meterStartWh: number;
  lastMeterWh?: number;
  idTag?: string | null;
}

export interface MeterValuesPayload {
  transactionId?: number;
  meterValue?: Array<{
    timestamp?: string;
    sampledValue?: Array<{
      value?: string;
      context?: string;
      format?: string;
      measurand?: string;
      phase?: string;
      location?: string;
      unit?: string;
    }>;
  }>;
}

/* ============================ Estado Global ============================ */
class TelemetryManager {
  private activeSessions = new Map<number, ActiveSession>();
  private lastUpdate = new Map<number, number>();
  private clientFilters = new Map<string, Set<string>>(); // clientId -> Set<chargeBoxId>

  constructor() {
    validateTelemetryConfig();
    console.log('[TelemetryManager] Inicializado com configuração validada');
  }
  
  // Configurações
  private readonly THROTTLE_INTERVAL_MS = Number(process.env.TELEMETRY_THROTTLE_MS ?? '7000'); // 7 segundos padrão
  private readonly MIN_UPDATE_INTERVAL_MS = 5000; // Mínimo 5 segundos entre atualizações

  /* ============================ Gerenciamento de Sessões ============================ */
  
  /**
   * Registra uma nova sessão ativa
   */
  startSession(params: {
    transactionId: number;
    chargeBoxId: string;
    startedAt: Date;
    meterStartWh: number;
    idTag?: string | null;
  }) {
    const session: ActiveSession = {
      transactionId: params.transactionId,
      chargeBoxId: params.chargeBoxId,
      startedAt: params.startedAt,
      meterStartWh: params.meterStartWh,
      idTag: params.idTag,
    };
    
    this.activeSessions.set(params.transactionId, session);
    telemetryLogger.logSessionStart(params.transactionId, params.chargeBoxId);
    
    // Limpar memória se necessário
    if (this.activeSessions.size > TELEMETRY_CONFIG.MAX_SESSIONS_MEMORY) {
      this.cleanupOldSessions();
    }
  }

  /**
   * Remove uma sessão ativa
   */
  stopSession(transactionId: number) {
    const session = this.activeSessions.get(transactionId);
    if (session) {
      this.activeSessions.delete(transactionId);
      this.lastUpdate.delete(transactionId);
      telemetryLogger.logSessionStop(transactionId, session.chargeBoxId);
    }
  }

  // Métodos de filtros por cliente
  addClientFilter(clientId: string, chargeBoxId: string): void {
    if (!this.clientFilters.has(clientId)) {
      this.clientFilters.set(clientId, new Set());
    }
    this.clientFilters.get(clientId)!.add(chargeBoxId);
  }

  removeClientFilter(clientId: string, chargeBoxId?: string): void {
    if (chargeBoxId) {
      this.clientFilters.get(clientId)?.delete(chargeBoxId);
    } else {
      this.clientFilters.delete(clientId);
    }
  }

  isClientAuthorized(clientId: string, chargeBoxId: string): boolean {
    const filters = this.clientFilters.get(clientId);
    return !filters || filters.size === 0 || filters.has(chargeBoxId);
  }

  // Limpeza de sessões antigas
  private cleanupOldSessions(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 horas
    let cleanedCount = 0;

    for (const [transactionId, session] of this.activeSessions.entries()) {
      const sessionAge = now - session.startedAt.getTime();
      if (sessionAge > maxAge) {
        this.activeSessions.delete(transactionId);
        this.lastUpdate.delete(transactionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[TelemetryManager] Limpeza: ${cleanedCount} sessões antigas removidas`);
    }
  }

  // Validação de dados de telemetria
  private validateTelemetryData(data: TelemetryData, transactionId?: number, chargeBoxId?: string): TelemetryData | null {
    const validated: TelemetryData = {};
    let hasValidData = false;

    // Validar potência
    if (data.power_kw !== undefined) {
      if (isValidPower(data.power_kw)) {
        validated.power_kw = data.power_kw;
        hasValidData = true;
      } else if (transactionId && chargeBoxId) {
        telemetryLogger.logValidationError(transactionId, chargeBoxId, 'power_kw', data.power_kw, 'Valor fora do range válido');
      }
    }

    // Validar energia
    if (data.energy_kwh !== undefined) {
      if (isValidEnergy(data.energy_kwh)) {
        validated.energy_kwh = data.energy_kwh;
        hasValidData = true;
      } else if (transactionId && chargeBoxId) {
        telemetryLogger.logValidationError(transactionId, chargeBoxId, 'energy_kwh', data.energy_kwh, 'Valor negativo ou inválido');
      }
    }

    // Validar tensão
    if (data.voltage_v !== undefined) {
      if (isValidVoltage(data.voltage_v)) {
        validated.voltage_v = data.voltage_v;
        hasValidData = true;
      } else if (transactionId && chargeBoxId) {
        telemetryLogger.logValidationError(transactionId, chargeBoxId, 'voltage_v', data.voltage_v, 'Valor fora do range válido');
      }
    }

    // Validar corrente
    if (data.current_a !== undefined) {
      if (isValidCurrent(data.current_a)) {
        validated.current_a = data.current_a;
        hasValidData = true;
      } else if (transactionId && chargeBoxId) {
        telemetryLogger.logValidationError(transactionId, chargeBoxId, 'current_a', data.current_a, 'Valor fora do range válido');
      }
    }

    // Validar SoC
    if (data.soc_percent !== undefined) {
      if (isValidSoC(data.soc_percent)) {
        validated.soc_percent = data.soc_percent;
        hasValidData = true;
      } else if (transactionId && chargeBoxId) {
        telemetryLogger.logValidationError(transactionId, chargeBoxId, 'soc_percent', data.soc_percent, 'Valor fora do range 0-100%');
      }
    }

    // Validar temperatura
    if (data.temperature_c !== undefined) {
      if (isValidTemperature(data.temperature_c)) {
        validated.temperature_c = data.temperature_c;
        hasValidData = true;
      } else if (transactionId && chargeBoxId) {
        telemetryLogger.logValidationError(transactionId, chargeBoxId, 'temperature_c', data.temperature_c, 'Valor fora do range válido');
      }
    }

    // Duração sempre é válida se presente (calculada internamente)
    if (data.duration_seconds !== undefined && Number.isFinite(data.duration_seconds) && data.duration_seconds >= 0) {
      validated.duration_seconds = data.duration_seconds;
      hasValidData = true;
    }

    return hasValidData ? validated : null;
  }

  /**
   * Verifica se uma sessão está ativa
   */
  isSessionActive(transactionId: number): boolean {
    return this.activeSessions.has(transactionId);
  }

  getActiveSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  getSessionCount(): number {
    return this.activeSessions.size;
  }

  /* ============================ Processamento de Telemetria ============================ */

  /**
   * Processa mensagens OCPP MeterValues e emite eventos de telemetria
   */
  async processMeterValues(chargeBoxId: string, transactionId: number, payload: MeterValuesPayload): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Verificar se a sessão está ativa
      const session = this.activeSessions.get(transactionId);
      if (!session) {
        return;
      }

      // Implementar throttling
      const now = Date.now();
      const lastUpdateTime = this.lastUpdate.get(transactionId) || 0;
      
      if (now - lastUpdateTime < TELEMETRY_CONFIG.THROTTLE_INTERVAL_MS) {
        telemetryLogger.logThrottledEvent(transactionId, chargeBoxId, now - lastUpdateTime);
        return;
      }

      // Extrair e validar dados de telemetria
      const telemetryData = this.extractTelemetryFromMeterValues(payload, session);
      
      if (!telemetryData || Object.keys(telemetryData).length === 0) {
        return;
      }

      // Validar dados extraídos
       const validatedData = this.validateTelemetryData(telemetryData, transactionId, chargeBoxId);
       if (!validatedData || Object.keys(validatedData).length === 0) {
         return;
       }

      // Atualizar timestamp
      this.lastUpdate.set(transactionId, now);

      // Publicar evento de telemetria via SSE
      await publish({
        type: 'telemetry.updated',
        chargeBoxId,
        transactionId,
        telemetry: validatedData,
        updatedAt: new Date().toISOString(),
      });

      // Log de sucesso
      const processingTime = Date.now() - startTime;
      telemetryLogger.logMeterValuesProcessed(transactionId, chargeBoxId, processingTime);
      telemetryLogger.logTelemetryEventSent(transactionId, chargeBoxId, Object.keys(validatedData));

    } catch (error) {
      telemetryLogger.logError(error as Error, { 
        transactionId, 
        chargeBoxId, 
        operation: 'processMeterValues' 
      });
    }
  }

  /* ============================ Extração de Dados OCPP ============================ */

  /**
   * Extrai dados de telemetria de uma mensagem MeterValues
   */
  private extractTelemetryFromMeterValues(payload: MeterValuesPayload, session: ActiveSession): TelemetryData {
    const telemetry: TelemetryData = {};
    
    try {
      const meterValues = payload.meterValue || [];
      
      for (const mv of meterValues) {
        const samples = mv.sampledValue || [];
        
        for (const sample of samples) {
          const measurand = (sample.measurand || '').toString();
          const valueStr = (sample.value || '').toString().trim();
          const value = Number(valueStr);
          
          if (!Number.isFinite(value)) continue;

          // Energia acumulada (Wh -> kWh)
          if (!measurand || /Energy\.Active\.Import\.Register/i.test(measurand)) {
            const energyKwh = Math.max(0, (value - session.meterStartWh) / 1000);
            telemetry.energy_kwh = Number(energyKwh.toFixed(3));
          }
          
          // Potência ativa (W -> kW)
          else if (/Power\.Active\.Import/i.test(measurand)) {
            telemetry.power_kw = Number((value / 1000).toFixed(3));
          }
          
          // Tensão (V)
          else if (/Voltage/i.test(measurand)) {
            telemetry.voltage_v = Number(value.toFixed(1));
          }
          
          // Corrente (A)
          else if (/Current\.Import/i.test(measurand)) {
            telemetry.current_a = Number(value.toFixed(2));
          }
          
          // Estado de carga (%)
          else if (/^SoC$/i.test(measurand)) {
            telemetry.soc_percent = Math.round(value);
          }
          
          // Temperatura (°C)
          else if (/Temperature/i.test(measurand)) {
            telemetry.temperature_c = Number(value.toFixed(1));
          }
        }
      }

      // Calcula duração da sessão
      const now = new Date();
      const durationMs = now.getTime() - session.startedAt.getTime();
      telemetry.duration_seconds = Math.floor(durationMs / 1000);

    } catch (error) {
      console.error('[Telemetry] Erro ao extrair dados:', error);
    }

    return telemetry;
  }

  /* ============================ Inicialização de Sessões Existentes ============================ */

  /**
   * Carrega sessões ativas do banco de dados na inicialização
   */
  async loadActiveSessionsFromDatabase() {
    try {
      console.log('[Telemetry] Carregando sessões ativas do banco...');
      
      const { data: sessions, error } = await sb
        .from('sessions')
        .select('transaction_id, charge_box_id, started_at, id_tag')
        .is('stopped_at', null)
        .order('started_at', { ascending: false });

      if (error) {
        console.error('[Telemetry] Erro ao carregar sessões ativas:', error);
        return;
      }

      for (const session of sessions || []) {
        // Busca meterStart do StartTransaction
        const { data: startEvent, error: startError } = await sb
          .from('ocpp_events')
          .select('payload')
          .eq('event_type', 'StartTransaction')
          .eq('transaction_id', session.transaction_id)
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (startError) {
          console.warn(`[Telemetry] Erro ao buscar StartTransaction para TX=${session.transaction_id}:`, startError);
          continue;
        }

        const meterStartWh = Number(startEvent?.payload?.meterStart ?? 0);

        this.startSession({
          transactionId: session.transaction_id,
          chargeBoxId: session.charge_box_id,
          startedAt: new Date(session.started_at),
          meterStartWh,
          idTag: session.id_tag,
        });
      }

      console.log(`[Telemetry] ${this.activeSessions.size} sessões ativas carregadas`);
    } catch (error) {
      console.error('[Telemetry] Erro ao carregar sessões ativas:', error);
    }
  }
}

// Instância singleton
export const telemetryManager = new TelemetryManager();

// Carrega sessões ativas na inicialização
telemetryManager.loadActiveSessionsFromDatabase().catch(console.error);