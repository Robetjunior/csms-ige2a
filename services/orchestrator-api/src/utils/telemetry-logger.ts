// src/utils/telemetry-logger.ts
import { TELEMETRY_CONFIG } from '../config/telemetry';

export interface TelemetryMetrics {
  totalSessions: number;
  activeSessions: number;
  totalMeterValuesProcessed: number;
  totalTelemetryEventsSent: number;
  totalValidationErrors: number;
  totalThrottledEvents: number;
  averageProcessingTimeMs: number;
  lastResetAt: Date;
}

export interface TelemetryLogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: 'session' | 'processing' | 'validation' | 'throttling' | 'performance';
  message: string;
  data?: any;
  transactionId?: number;
  chargeBoxId?: string;
  processingTimeMs?: number;
}

class TelemetryLogger {
  private metrics: TelemetryMetrics = {
    totalSessions: 0,
    activeSessions: 0,
    totalMeterValuesProcessed: 0,
    totalTelemetryEventsSent: 0,
    totalValidationErrors: 0,
    totalThrottledEvents: 0,
    averageProcessingTimeMs: 0,
    lastResetAt: new Date(),
  };

  private recentLogs: TelemetryLogEntry[] = [];
  private readonly MAX_RECENT_LOGS = 100;
  private processingTimes: number[] = [];
  private readonly MAX_PROCESSING_TIMES = 50;

  // Logs estruturados
  logSessionStart(transactionId: number, chargeBoxId: string): void {
    this.metrics.totalSessions++;
    this.metrics.activeSessions++;
    
    this.addLog({
      level: 'info',
      category: 'session',
      message: `Sessão iniciada`,
      transactionId,
      chargeBoxId,
    });
  }

  logSessionStop(transactionId: number, chargeBoxId: string): void {
    this.metrics.activeSessions = Math.max(0, this.metrics.activeSessions - 1);
    
    this.addLog({
      level: 'info',
      category: 'session',
      message: `Sessão finalizada`,
      transactionId,
      chargeBoxId,
    });
  }

  logMeterValuesProcessed(transactionId: number, chargeBoxId: string, processingTimeMs: number): void {
    this.metrics.totalMeterValuesProcessed++;
    this.addProcessingTime(processingTimeMs);
    
    if (TELEMETRY_CONFIG.ENABLE_DETAILED_LOGS) {
      this.addLog({
        level: 'debug',
        category: 'processing',
        message: `MeterValues processado`,
        transactionId,
        chargeBoxId,
        processingTimeMs,
      });
    }
  }

  logTelemetryEventSent(transactionId: number, chargeBoxId: string, dataKeys: string[]): void {
    this.metrics.totalTelemetryEventsSent++;
    
    if (TELEMETRY_CONFIG.ENABLE_DETAILED_LOGS) {
      this.addLog({
        level: 'info',
        category: 'processing',
        message: `Evento de telemetria enviado`,
        transactionId,
        chargeBoxId,
        data: { dataKeys },
      });
    }
  }

  logValidationError(transactionId: number, chargeBoxId: string, field: string, value: any, reason: string): void {
    this.metrics.totalValidationErrors++;
    
    if (TELEMETRY_CONFIG.LOG_INVALID_DATA) {
      this.addLog({
        level: 'warn',
        category: 'validation',
        message: `Erro de validação: ${field}`,
        transactionId,
        chargeBoxId,
        data: { field, value, reason },
      });
    }
  }

  logThrottledEvent(transactionId: number, chargeBoxId: string, timeSinceLastMs: number): void {
    this.metrics.totalThrottledEvents++;
    
    if (TELEMETRY_CONFIG.ENABLE_DETAILED_LOGS) {
      this.addLog({
        level: 'debug',
        category: 'throttling',
        message: `Evento throttled`,
        transactionId,
        chargeBoxId,
        data: { timeSinceLastMs, throttleIntervalMs: TELEMETRY_CONFIG.THROTTLE_INTERVAL_MS },
      });
    }
  }

  logError(error: Error, context?: { transactionId?: number; chargeBoxId?: string; operation?: string }): void {
    this.addLog({
      level: 'error',
      category: 'processing',
      message: `Erro: ${error.message}`,
      transactionId: context?.transactionId,
      chargeBoxId: context?.chargeBoxId,
      data: { 
        stack: error.stack,
        operation: context?.operation,
      },
    });
  }

  // Métricas e relatórios
  getMetrics(): TelemetryMetrics {
    return { ...this.metrics };
  }

  getRecentLogs(limit: number = 20): TelemetryLogEntry[] {
    return this.recentLogs.slice(-limit);
  }

  getPerformanceStats(): { 
    averageMs: number; 
    minMs: number; 
    maxMs: number; 
    p95Ms: number; 
    sampleSize: number;
  } {
    if (this.processingTimes.length === 0) {
      return { averageMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, sampleSize: 0 };
    }

    const sorted = [...this.processingTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    
    return {
      averageMs: this.metrics.averageProcessingTimeMs,
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      p95Ms: sorted[p95Index] || 0,
      sampleSize: sorted.length,
    };
  }

  resetMetrics(): void {
    this.metrics = {
      totalSessions: 0,
      activeSessions: this.metrics.activeSessions, // Manter sessões ativas
      totalMeterValuesProcessed: 0,
      totalTelemetryEventsSent: 0,
      totalValidationErrors: 0,
      totalThrottledEvents: 0,
      averageProcessingTimeMs: 0,
      lastResetAt: new Date(),
    };
    this.processingTimes = [];
    this.recentLogs = [];
    
    console.log('[TelemetryLogger] Métricas resetadas');
  }

  // Relatório de status
  logStatusReport(): void {
    const metrics = this.getMetrics();
    const performance = this.getPerformanceStats();
    
    console.log('[TelemetryLogger] Status Report:', {
      metrics,
      performance,
      config: {
        throttleMs: TELEMETRY_CONFIG.THROTTLE_INTERVAL_MS,
        detailedLogs: TELEMETRY_CONFIG.ENABLE_DETAILED_LOGS,
        logInvalidData: TELEMETRY_CONFIG.LOG_INVALID_DATA,
      },
    });
  }

  // Métodos privados
  private addLog(entry: Omit<TelemetryLogEntry, 'timestamp'>): void {
    const logEntry: TelemetryLogEntry = {
      ...entry,
      timestamp: new Date(),
    };

    this.recentLogs.push(logEntry);
    
    // Manter apenas os logs mais recentes
    if (this.recentLogs.length > this.MAX_RECENT_LOGS) {
      this.recentLogs = this.recentLogs.slice(-this.MAX_RECENT_LOGS);
    }

    // Log no console se necessário
    if (entry.level === 'error' || (entry.level === 'warn' && TELEMETRY_CONFIG.LOG_INVALID_DATA)) {
      const logMessage = `[TelemetryLogger] ${entry.category.toUpperCase()}: ${entry.message}`;
      const logData = entry.data ? ` | Data: ${JSON.stringify(entry.data)}` : '';
      const logContext = entry.transactionId ? ` | TX: ${entry.transactionId}` : '';
      
      if (entry.level === 'error') {
        console.error(logMessage + logContext + logData);
      } else {
        console.warn(logMessage + logContext + logData);
      }
    }
  }

  private addProcessingTime(timeMs: number): void {
    this.processingTimes.push(timeMs);
    
    // Manter apenas as medições mais recentes
    if (this.processingTimes.length > this.MAX_PROCESSING_TIMES) {
      this.processingTimes = this.processingTimes.slice(-this.MAX_PROCESSING_TIMES);
    }

    // Recalcular média
    this.metrics.averageProcessingTimeMs = 
      this.processingTimes.reduce((sum, time) => sum + time, 0) / this.processingTimes.length;
  }
}

// Instância singleton
export const telemetryLogger = new TelemetryLogger();

// Agendar relatórios periódicos se logs detalhados estiverem habilitados
if (TELEMETRY_CONFIG.ENABLE_DETAILED_LOGS) {
  setInterval(() => {
    telemetryLogger.logStatusReport();
  }, 5 * 60 * 1000); // A cada 5 minutos
}