// src/api/telemetry-status.ts
import { Router } from 'express';
import { telemetryManager } from '../services/telemetry-manager';
import { telemetryLogger } from '../utils/telemetry-logger';
import { TELEMETRY_CONFIG } from '../config/telemetry';

const router = Router();

/**
 * GET /v1/telemetry/status
 * Retorna o status atual do sistema de telemetria
 */
router.get('/status', (req, res) => {
  try {
    const metrics = telemetryLogger.getMetrics();
    const performance = telemetryLogger.getPerformanceStats();
    const activeSessions = telemetryManager.getActiveSessions();
    
    const status = {
      system: {
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      config: {
        throttleIntervalMs: TELEMETRY_CONFIG.THROTTLE_INTERVAL_MS,
        minUpdateIntervalMs: TELEMETRY_CONFIG.MIN_UPDATE_INTERVAL_MS,
        maxSessionsMemory: TELEMETRY_CONFIG.MAX_SESSIONS_MEMORY,
        detailedLogsEnabled: TELEMETRY_CONFIG.ENABLE_DETAILED_LOGS,
        rateLimitingEnabled: TELEMETRY_CONFIG.ENABLE_RATE_LIMITING,
      },
      metrics,
      performance,
      sessions: {
        active: activeSessions.length,
        details: activeSessions.map(session => ({
          transactionId: session.transactionId,
          chargeBoxId: session.chargeBoxId,
          startedAt: session.startedAt,
          durationSeconds: Math.floor((Date.now() - session.startedAt.getTime()) / 1000),
          lastMeterWh: session.lastMeterWh,
        })),
      },
    };

    res.json(status);
  } catch (error) {
    console.error('[TelemetryStatus] Erro ao obter status:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      message: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
});

/**
 * GET /v1/telemetry/logs
 * Retorna os logs recentes de telemetria
 */
router.get('/logs', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200); // Máximo 200 logs
    const level = req.query.level as string;
    const category = req.query.category as string;
    
    let logs = telemetryLogger.getRecentLogs(limit);
    
    // Filtrar por nível se especificado
    if (level && ['info', 'warn', 'error', 'debug'].includes(level)) {
      logs = logs.filter(log => log.level === level);
    }
    
    // Filtrar por categoria se especificado
    if (category && ['session', 'processing', 'validation', 'throttling', 'performance'].includes(category)) {
      logs = logs.filter(log => log.category === category);
    }
    
    res.json({
      logs,
      total: logs.length,
      filters: { level, category, limit },
    });
  } catch (error) {
    console.error('[TelemetryStatus] Erro ao obter logs:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      message: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
});

/**
 * POST /v1/telemetry/reset-metrics
 * Reseta as métricas de telemetria
 */
router.post('/reset-metrics', (req, res) => {
  try {
    telemetryLogger.resetMetrics();
    
    res.json({
      success: true,
      message: 'Métricas resetadas com sucesso',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[TelemetryStatus] Erro ao resetar métricas:', error);
    res.status(500).json({ 
      error: 'Erro interno do servidor',
      message: error instanceof Error ? error.message : 'Erro desconhecido',
    });
  }
});

/**
 * GET /v1/telemetry/health
 * Endpoint de health check simplificado
 */
router.get('/health', (req, res) => {
  try {
    const metrics = telemetryLogger.getMetrics();
    const activeSessions = telemetryManager.getActiveSessions().length;
    
    // Determinar status de saúde
    let status = 'healthy';
    const issues = [];
    
    if (metrics.totalValidationErrors > metrics.totalTelemetryEventsSent * 0.1) {
      status = 'degraded';
      issues.push('Alta taxa de erros de validação');
    }
    
    if (activeSessions > TELEMETRY_CONFIG.MAX_SESSIONS_MEMORY * 0.9) {
      status = 'warning';
      issues.push('Muitas sessões ativas');
    }
    
    const response = {
      status,
      timestamp: new Date().toISOString(),
      activeSessions,
      totalEvents: metrics.totalTelemetryEventsSent,
      validationErrors: metrics.totalValidationErrors,
      issues: issues.length > 0 ? issues : undefined,
    };
    
    const httpStatus = status === 'healthy' ? 200 : status === 'warning' ? 200 : 503;
    res.status(httpStatus).json(response);
  } catch (error) {
    console.error('[TelemetryStatus] Erro no health check:', error);
    res.status(503).json({ 
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Erro desconhecido',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;