import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

/**
 * GET /charge/:chargeBoxId
 * Proxy simplificado para o app mobile consumir telemetria em tempo real
 * Repassa para /v1/sessions/active/:chargeBoxId/detail do Orchestrator
 */
router.get('/charge/:chargeBoxId', async (req: Request, res: Response) => {
  try {
    const chargeBoxId = String(req.params.chargeBoxId || '').trim();
    if (!chargeBoxId) {
      return res.status(400).json({ 
        error: 'invalid_charge_box_id',
        message: 'chargeBoxId é obrigatório' 
      });
    }

    // URL do Orchestrator (interno)
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
    const apiKey = process.env.ORCH_API_KEY || 'minha_chave_super_secreta';
    
    // Fazer requisição para o Orchestrator
    const response = await axios.get(
      `${orchestratorUrl}/v1/sessions/active/${chargeBoxId}/detail`,
      {
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10s timeout
      }
    );

    const data = response.data;
    
    // Simplificar resposta para o app mobile
    if (!data.session) {
      return res.json({
        status: 'available',
        charging: false,
        chargeBoxId,
        session: null,
        telemetry: null
      });
    }

    // Sessão ativa - formatar dados para o mobile
    const mobileResponse = {
      status: 'charging',
      charging: true,
      chargeBoxId,
      session: {
        transactionId: data.session.transaction_id,
        startedAt: data.session.started_at,
        durationSeconds: data.session.duration_seconds,
        idTag: data.session.id_tag
      },
      telemetry: data.telemetry ? {
        kwh: data.telemetry.kwh || 0,
        powerKw: data.telemetry.power_kw || 0,
        voltageV: data.telemetry.voltage_v || 0,
        currentA: data.telemetry.current_a || 0,
        temperatureC: data.telemetry.temperature_c || null,
        socPercent: data.telemetry.soc_percent_at || null
      } : null
    };

    return res.json(mobileResponse);

  } catch (error: any) {
    console.error('[Mobile Proxy] Error fetching telemetry:', error.message);
    
    // Tratar diferentes tipos de erro
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'Orchestrator não está disponível'
      });
    }
    
    if (error.response?.status === 401) {
      return res.status(500).json({
        error: 'auth_error',
        message: 'Erro de autenticação com o Orchestrator'
      });
    }
    
    if (error.response?.status >= 400 && error.response?.status < 500) {
      return res.status(error.response.status).json({
        error: 'client_error',
        message: error.response.data?.error || 'Erro na requisição'
      });
    }

    return res.status(500).json({
      error: 'internal_error',
      message: 'Erro interno do servidor'
    });
  }
});

/**
 * GET /charge/:chargeBoxId/status
 * Endpoint adicional para verificar apenas o status (sem telemetria completa)
 */
router.get('/charge/:chargeBoxId/status', async (req: Request, res: Response) => {
  try {
    const chargeBoxId = String(req.params.chargeBoxId || '').trim();
    if (!chargeBoxId) {
      return res.status(400).json({ 
        error: 'invalid_charge_box_id' 
      });
    }

    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://localhost:3000';
    const apiKey = process.env.ORCH_API_KEY || 'minha_chave_super_secreta';
    
    const response = await axios.get(
      `${orchestratorUrl}/v1/sessions/active/${chargeBoxId}/detail`,
      {
        headers: { 'X-API-Key': apiKey },
        timeout: 5000
      }
    );

    const hasActiveSession = Boolean(response.data.session);
    
    return res.json({
      chargeBoxId,
      status: hasActiveSession ? 'charging' : 'available',
      charging: hasActiveSession,
      lastCheck: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('[Mobile Proxy Status] Error:', error.message);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Erro ao verificar status'
    });
  }
});

export default router;