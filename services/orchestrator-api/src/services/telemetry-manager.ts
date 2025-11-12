// src/services/telemetry-manager.ts
import { publish } from '../routes/stream';
import { TelemetryData } from '../routes/stream';
import { pg } from '../db';
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
import { sb } from '../../supabase';

/* ============================ Tipos ============================ */
export interface ActiveSession {
  transactionId: number;
  chargeBoxId: string;
  startedAt: Date;
  lastTelemetryUpdate?: Date;
  meterStartWh: number;
  lastMeterWh?: number;
  idTag?: string | null;
  lastNormalized?: Partial<TelemetryData>;
  pricePerKWh?: number;
}

export interface MeterValuesPayload {
  transactionId?: number;
  connectorId?: number;
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

// OCPP 2.0.1 — TransactionEvent
export interface TransactionEventPayload {
  eventType: 'Started' | 'Updated' | 'Ended';
  timestamp?: string;
  transactionInfo?: {
    transactionId?: string | number;
    totalEnergyConsumed?: number; // Wh
    idToken?: { idToken?: string } | null;
  };
  evse?: { id?: number; connectorId?: number } | null;
  transactionData?: Array<{
    sampledValue?: Array<{
      value?: string | number;
      measurand?: string;   // e.g. Energy.Active.Import.Register, Power.Active.Import
      phase?: string;       // L1, L2, L3, L1-N, etc.
      unit?: string;        // Wh, W, V, A, C, Percent
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
  private readonly THROTTLE_INTERVAL_MS = Number(process.env.TELEMETRY_THROTTLE_MS ?? '5000'); // 5s padrão (alinha ao simulador)
  private readonly MIN_UPDATE_INTERVAL_MS = 3000; // Permite modo rápido (~3s)
  private priceCache = new Map<string, { price: number; at: number }>();
  private readonly PRICE_TTL_MS = 5 * 60 * 1000; // 5 minutos

  /** Resolve e cacheia o preço por kWh para um charge box */
  private async getPricePerKWh(chargeBoxId: string): Promise<number | undefined> {
    try {
      const now = Date.now();
      const cached = this.priceCache.get(chargeBoxId);
      if (cached && now - cached.at < this.PRICE_TTL_MS) return cached.price;

      // 1) Tentar resolver via RPC resolve_tariff (ANY)
      const atISO = new Date().toISOString();
      const r = await sb.rpc('resolve_tariff', {
        p_charge_box_id: chargeBoxId,
        p_mode: 'ANY',
        p_at: atISO,
      });
      if (!r.error && Array.isArray(r.data) && r.data.length) {
        const price = Number(r.data[0]?.price_kwh ?? 0);
        if (Number.isFinite(price) && price >= 0) {
          this.priceCache.set(chargeBoxId, { price, at: now });
          return price;
        }
      }

      // 2) Fallback: último snapshot de tarifa para o charge box
      const snap = await sb
        .from('tariff_snapshots')
        .select('price_kwh')
        .eq('charge_box_id', chargeBoxId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const price = Number(snap?.data?.price_kwh ?? NaN);
      if (Number.isFinite(price) && price >= 0) {
        this.priceCache.set(chargeBoxId, { price, at: now });
        return price;
      }

      // 3) Retornar cache antigo se existir
      if (cached) return cached.price;
      return undefined;
    } catch (err) {
      telemetryLogger.logError(err as Error, { operation: 'getPricePerKWh', chargeBoxId });
      const cached = this.priceCache.get(chargeBoxId);
      return cached?.price;
    }
  }

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
      lastMeterWh: params.meterStartWh,
      idTag: params.idTag,
      lastNormalized: undefined,
      pricePerKWh: undefined,
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

      // Extrair e validar dados de telemetria (formato interno)
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

      const updatedAtISO = new Date().toISOString();

      // Persistir última telemetria por sessão (telemetry_latest)
      try {
        const connectorId = Number(payload.connectorId || 1);
        await pg.query(
          `INSERT INTO orchestrator.telemetry_latest (
             transaction_id, charge_box_id, connector_id,
             energy_kwh, power_kw, voltage_v, current_a, soc_percent, temperature_c,
             duration_seconds, at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (transaction_id, connector_id)
           DO UPDATE SET
             energy_kwh = COALESCE(EXCLUDED.energy_kwh, orchestrator.telemetry_latest.energy_kwh),
             power_kw = COALESCE(EXCLUDED.power_kw, orchestrator.telemetry_latest.power_kw),
             voltage_v = COALESCE(EXCLUDED.voltage_v, orchestrator.telemetry_latest.voltage_v),
             current_a = COALESCE(EXCLUDED.current_a, orchestrator.telemetry_latest.current_a),
             soc_percent = COALESCE(EXCLUDED.soc_percent, orchestrator.telemetry_latest.soc_percent),
             temperature_c = COALESCE(EXCLUDED.temperature_c, orchestrator.telemetry_latest.temperature_c),
             duration_seconds = EXCLUDED.duration_seconds,
             at = EXCLUDED.at`,
          [
            transactionId,
            chargeBoxId,
            connectorId,
            validatedData.energy_kwh ?? null,
            validatedData.power_kw ?? null,
            validatedData.voltage_v ?? null,
            validatedData.current_a ?? null,
            validatedData.soc_percent ?? null,
            validatedData.temperature_c ?? null,
            validatedData.duration_seconds ?? null,
            updatedAtISO,
          ]
        );
      } catch (err) {
        telemetryLogger.logError(err as Error, { transactionId, chargeBoxId, operation: 'upsertTelemetryLatest' });
      }

      // Montar payload normalizado para frontend
      const connectorId = Number(payload.connectorId || 1);
      const normalized: TelemetryData = {
        chargePointId: chargeBoxId,
        connectorId,
        transactionId,
        timestampUtc: updatedAtISO,
        context: 'Sample.Periodic',
        batteryPercent: validatedData.soc_percent,
        powerKW: validatedData.power_kw,
        voltageV: validatedData.voltage_v !== undefined ? Math.round(validatedData.voltage_v) : undefined,
        currentA: validatedData.current_a,
        temperatureC: validatedData.temperature_c !== undefined ? Number(validatedData.temperature_c.toFixed ? (validatedData.temperature_c as any).toFixed(2) : validatedData.temperature_c) : undefined,
        energyKWh: validatedData.energy_kwh,
        durationMin: validatedData.duration_seconds !== undefined ? Math.round((validatedData.duration_seconds as number) / 60) : undefined,
        source: 'live',
      };

      // Preço por kWh (cache/snapshot)
      const price = await this.getPricePerKWh(chargeBoxId);
      normalized.pricePerKWh = price;
      normalized.totalCost = typeof normalized.energyKWh === 'number' ? Number((normalized.energyKWh * (price || 0)).toFixed(2)) : undefined;

      // Fallback de valores ausentes baseado no último payload
      const last = session.lastNormalized || {};
      let reused = false;
      const keys: (keyof TelemetryData)[] = ['batteryPercent','powerKW','voltageV','currentA','temperatureC','energyKWh'];
      for (const k of keys) {
        if (normalized[k] === undefined && last[k] !== undefined) {
          normalized[k] = last[k] as any;
          reused = true;
        }
      }
      normalized.source = reused ? 'stale' : 'live';
      session.lastNormalized = normalized;

      // Publicar evento de telemetria via SSE
      await publish({ type: 'telemetry.updated', chargeBoxId, transactionId, telemetry: normalized, updatedAt: updatedAtISO });

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
    // Acumuladores por fase
    const powerWByPhase: Record<string, number> = {};
    const voltageVByPhase: Record<string, number> = {};
    const currentAByPhase: Record<string, number> = {};
    let energyWhLatest: number | undefined;
    
    try {
      const meterValues = payload.meterValue || [];
      
      for (const mv of meterValues) {
        const samples = mv.sampledValue || [];
        
        for (const sample of samples) {
          const measurand = (sample.measurand || '').toString();
          const phase = (sample.phase || '').toString();
          const valueStr = (sample.value || '').toString().trim();
          const value = Number(valueStr);
          if (!Number.isFinite(value)) continue;

          // Energia acumulada (Wh)
          if (!measurand || /Energy\.Active\.Import\.Register/i.test(measurand)) {
            energyWhLatest = value;
          }
          
          // Potência ativa (W) — somar por fase
          else if (/Power\.Active\.Import/i.test(measurand)) {
            const key = phase || 'total';
            powerWByPhase[key] = (powerWByPhase[key] || 0) + value;
          }
          
          // Tensão (V) — média das fases medidas
          else if (/Voltage/i.test(measurand)) {
            const key = phase || 'total';
            voltageVByPhase[key] = value;
          }
          
          // Corrente (A) — somar por fase
          else if (/Current\.Import/i.test(measurand) || /^Current$/i.test(measurand)) {
            const key = phase || 'total';
            currentAByPhase[key] = (currentAByPhase[key] || 0) + value;
          }
          
          // Estado de carga (%) — suportar variações de measurand
          else if (/(^SoC$)|StateOfCharge|Battery\.SoC/i.test(measurand)) {
            telemetry.soc_percent = Math.round(value);
          }
          
          // Temperatura (°C)
          else if (/Temperature/i.test(measurand)) {
            telemetry.temperature_c = Number(value.toFixed(1));
          }
        }
      }

      // Energia acumulada (kWh) a partir do último Wh, garantindo monotonicidade
      if (typeof energyWhLatest === 'number' && Number.isFinite(energyWhLatest)) {
        const prevWh = typeof session.lastMeterWh === 'number' && Number.isFinite(session.lastMeterWh)
          ? session.lastMeterWh!
          : session.meterStartWh;
        const monotonicWh = energyWhLatest < prevWh ? prevWh : energyWhLatest;
        session.lastMeterWh = monotonicWh;
        const energyKwh = Math.max(0, (monotonicWh - session.meterStartWh) / 1000);
        telemetry.energy_kwh = Number(energyKwh.toFixed(3));
      }

      // Potência (kW): somar todas as fases (ou total)
      const totalPowerW = Object.values(powerWByPhase).reduce((a, b) => a + b, 0);
      if (Number.isFinite(totalPowerW) && totalPowerW > 0) {
        telemetry.power_kw = Number((totalPowerW / 1000).toFixed(3));
      }

      // Tensão (V): média das fases medidas
      const voltVals = Object.values(voltageVByPhase).filter(v => Number.isFinite(v));
      if (voltVals.length) {
        const avgV = voltVals.reduce((a, b) => a + b, 0) / voltVals.length;
        telemetry.voltage_v = Number(avgV.toFixed(1));
      }

      // Corrente (A): soma das fases
      const totalA = Object.values(currentAByPhase).reduce((a, b) => a + b, 0);
      if (Number.isFinite(totalA) && totalA > 0) {
        telemetry.current_a = Number(totalA.toFixed(2));
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
      // Preferir Postgres (evita TLS em ambientes com interceptador)
      const sessions = await pg.query<{
        transaction_id: number;
        charge_box_id: string;
        started_at: string;
        id_tag: string | null;
      }>(
        `SELECT transaction_id, charge_box_id, started_at, id_tag
           FROM orchestrator.sessions
          WHERE stopped_at IS NULL
          ORDER BY started_at DESC`
      );

      for (const s of sessions.rows) {
        // Busca meterStart do StartTransaction
        const rStart = await pg.query<{ payload: any }>(
          `SELECT payload
             FROM orchestrator.ocpp_events
            WHERE event_type = $1 AND transaction_id = $2
            ORDER BY id ASC
            LIMIT 1`,
          ['StartTransaction', s.transaction_id]
        );

        const meterStartWh = Number((rStart.rows[0]?.payload?.meterStart ?? 0)) || 0;

        this.startSession({
          transactionId: s.transaction_id,
          chargeBoxId: s.charge_box_id,
          startedAt: new Date(s.started_at),
          meterStartWh,
          idTag: s.id_tag,
        });
      }

      console.log(`[Telemetry] ${this.activeSessions.size} sessões ativas carregadas`);
    } catch (error) {
      console.error('[Telemetry] Erro ao carregar sessões ativas:', error);
    }
  }

  /**
   * Processa eventos OCPP 2.0.1 TransactionEvent (Updated/Ended) e emite telemetria
   */
  async processTransactionEvent(chargeBoxId: string, payload: TransactionEventPayload): Promise<void> {
    try {
      const tx = Number(payload?.transactionInfo?.transactionId ?? payload?.evse?.id ?? 0);
      if (!Number.isFinite(tx) || tx <= 0) return;

      const session = this.activeSessions.get(tx);
      if (!session) return;

      const telemetry: TelemetryData = {};
      const powerWByPhase: Record<string, number> = {};
      const voltageVByPhase: Record<string, number> = {};
      const currentAByPhase: Record<string, number> = {};

      // totalEnergyConsumed (Wh) — fonte preferencial
      const totalEnergyConsumed = Number(payload?.transactionInfo?.totalEnergyConsumed ?? NaN);
      if (Number.isFinite(totalEnergyConsumed)) {
        // Atualiza lastMeterWh garantindo monotonicidade
        const prevWh = typeof session.lastMeterWh === 'number' && Number.isFinite(session.lastMeterWh)
          ? session.lastMeterWh!
          : session.meterStartWh;
        const monotonicWh = totalEnergyConsumed < prevWh ? prevWh : totalEnergyConsumed;
        session.lastMeterWh = monotonicWh;
        const energyKwh = Math.max(0, monotonicWh / 1000);
        telemetry.energy_kwh = Number(energyKwh.toFixed(3));
      }

      // transactionData.sampledValue — similar ao MeterValues
      const arr = payload?.transactionData || [];
      for (const td of arr) {
        const samples = td?.sampledValue || [];
        for (const sv of samples) {
          const meas = (sv?.measurand || '').toString();
          const phase = (sv?.phase || '').toString();
          const val = Number((sv?.value ?? '').toString());
          if (!Number.isFinite(val)) continue;

          if (/Power\.Active\.Import/i.test(meas)) {
            const key = phase || 'total';
            powerWByPhase[key] = (powerWByPhase[key] || 0) + val;
          } else if (/Voltage/i.test(meas)) {
            const key = phase || 'total';
            voltageVByPhase[key] = val;
          } else if (/Current\.Import/i.test(meas) || /^Current$/i.test(meas)) {
            const key = phase || 'total';
            currentAByPhase[key] = (currentAByPhase[key] || 0) + val;
          } else if (/(^SoC$)|StateOfCharge|Battery\.SoC/i.test(meas)) {
            telemetry.soc_percent = Math.round(val);
          } else if (/Temperature/i.test(meas)) {
            telemetry.temperature_c = Number(val.toFixed(1));
          } else if (!meas || /Energy\.Active\.Import\.Register/i.test(meas)) {
            const prevWh = typeof session.lastMeterWh === 'number' && Number.isFinite(session.lastMeterWh)
              ? session.lastMeterWh!
              : session.meterStartWh;
            const monotonicWh = val < prevWh ? prevWh : val;
            session.lastMeterWh = monotonicWh;
            const energyKwh = Math.max(0, (monotonicWh - session.meterStartWh) / 1000);
            telemetry.energy_kwh = Number(energyKwh.toFixed(3));
          }
        }
      }

      const totalPowerW = Object.values(powerWByPhase).reduce((a, b) => a + b, 0);
      if (Number.isFinite(totalPowerW) && totalPowerW > 0) telemetry.power_kw = Number((totalPowerW / 1000).toFixed(3));
      const voltVals = Object.values(voltageVByPhase).filter(v => Number.isFinite(v));
      if (voltVals.length) telemetry.voltage_v = Number((voltVals.reduce((a, b) => a + b, 0) / voltVals.length).toFixed(1));
      const totalA = Object.values(currentAByPhase).reduce((a, b) => a + b, 0);
      if (Number.isFinite(totalA) && totalA > 0) telemetry.current_a = Number(totalA.toFixed(2));

      const now = new Date();
      telemetry.duration_seconds = Math.floor((now.getTime() - session.startedAt.getTime()) / 1000);

      const validated = this.validateTelemetryData(telemetry, tx, chargeBoxId);
      if (!validated) return;

      const updatedAtISO = new Date().toISOString();
      try {
        const connectorId = Number(payload?.evse?.connectorId || 1);
        await pg.query(
          `INSERT INTO orchestrator.telemetry_latest (
             transaction_id, charge_box_id, connector_id,
             energy_kwh, power_kw, voltage_v, current_a, soc_percent, temperature_c,
             duration_seconds, at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (transaction_id, connector_id)
           DO UPDATE SET
             energy_kwh = COALESCE(EXCLUDED.energy_kwh, orchestrator.telemetry_latest.energy_kwh),
             power_kw = COALESCE(EXCLUDED.power_kw, orchestrator.telemetry_latest.power_kw),
             voltage_v = COALESCE(EXCLUDED.voltage_v, orchestrator.telemetry_latest.voltage_v),
             current_a = COALESCE(EXCLUDED.current_a, orchestrator.telemetry_latest.current_a),
             soc_percent = COALESCE(EXCLUDED.soc_percent, orchestrator.telemetry_latest.soc_percent),
             temperature_c = COALESCE(EXCLUDED.temperature_c, orchestrator.telemetry_latest.temperature_c),
             duration_seconds = EXCLUDED.duration_seconds,
             at = EXCLUDED.at`,
          [
            tx,
            chargeBoxId,
            Number(payload?.evse?.connectorId || 1),
            validated.energy_kwh ?? null,
            validated.power_kw ?? null,
            validated.voltage_v ?? null,
            validated.current_a ?? null,
            validated.soc_percent ?? null,
            validated.temperature_c ?? null,
            validated.duration_seconds ?? null,
            updatedAtISO,
          ]
        );
      } catch (err) {
        telemetryLogger.logError(err as Error, { transactionId: tx, chargeBoxId, operation: 'upsertTelemetryLatest@TransactionEvent' });
      }

      // Montar payload normalizado e publicar via SSE
      const connectorId = Number(payload?.evse?.connectorId || 1);
      const normalized: TelemetryData = {
        chargePointId: chargeBoxId,
        connectorId,
        transactionId: tx,
        timestampUtc: updatedAtISO,
        context: payload?.eventType === 'Ended' ? 'Sample.Ended' : 'Sample.Periodic',
        batteryPercent: validated.soc_percent,
        powerKW: validated.power_kw,
        voltageV: validated.voltage_v !== undefined ? Math.round(validated.voltage_v) : undefined,
        currentA: validated.current_a,
        temperatureC: validated.temperature_c !== undefined ? Number(validated.temperature_c.toFixed ? (validated.temperature_c as any).toFixed(2) : validated.temperature_c) : undefined,
        energyKWh: validated.energy_kwh,
        durationMin: validated.duration_seconds !== undefined ? Math.round((validated.duration_seconds as number) / 60) : undefined,
        source: 'live',
      };

      const price = await this.getPricePerKWh(chargeBoxId);
      normalized.pricePerKWh = price;
      normalized.totalCost = typeof normalized.energyKWh === 'number' ? Number((normalized.energyKWh * (price || 0)).toFixed(2)) : undefined;

      const last = session.lastNormalized || {};
      let reused = false;
      const keys: (keyof TelemetryData)[] = ['batteryPercent','powerKW','voltageV','currentA','temperatureC','energyKWh'];
      for (const k of keys) {
        if (normalized[k] === undefined && last[k] !== undefined) {
          normalized[k] = last[k] as any;
          reused = true;
        }
      }
      normalized.source = reused ? 'stale' : 'live';
      session.lastNormalized = normalized;

      await publish({ type: 'telemetry.updated', chargeBoxId, transactionId: tx, telemetry: normalized, updatedAt: updatedAtISO });
    } catch (error) {
      telemetryLogger.logError(error as Error, { operation: 'processTransactionEvent' });
    }
  }
}

// Instância singleton
export const telemetryManager = new TelemetryManager();

// Carrega sessões ativas na inicialização
telemetryManager.loadActiveSessionsFromDatabase().catch(console.error);