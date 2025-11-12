// src/config/telemetry.ts
export const TELEMETRY_CONFIG = {
  // Throttling e performance
  THROTTLE_INTERVAL_MS: Number(process.env.TELEMETRY_THROTTLE_MS ?? '5000'),
  MIN_UPDATE_INTERVAL_MS: Number(process.env.TELEMETRY_MIN_UPDATE_MS ?? '5000'),
  MAX_SESSIONS_MEMORY: Number(process.env.TELEMETRY_MAX_SESSIONS ?? '1000'),
  
  // Validação de dados
  MAX_POWER_KW: Number(process.env.TELEMETRY_MAX_POWER_KW ?? '350'), // 350kW máximo típico para DC fast charging
  MAX_VOLTAGE_V: Number(process.env.TELEMETRY_MAX_VOLTAGE_V ?? '1000'), // 1000V máximo
  MAX_CURRENT_A: Number(process.env.TELEMETRY_MAX_CURRENT_A ?? '500'), // 500A máximo
  MAX_TEMPERATURE_C: Number(process.env.TELEMETRY_MAX_TEMP_C ?? '80'), // 80°C máximo
  MIN_TEMPERATURE_C: Number(process.env.TELEMETRY_MIN_TEMP_C ?? '-40'), // -40°C mínimo
  
  // Filtros e logs
  ENABLE_DETAILED_LOGS: process.env.TELEMETRY_DETAILED_LOGS === 'true',
  LOG_INVALID_DATA: process.env.TELEMETRY_LOG_INVALID !== 'false', // true por padrão
  
  // Rate limiting por cliente
  ENABLE_RATE_LIMITING: process.env.TELEMETRY_RATE_LIMITING === 'true',
  RATE_LIMIT_REQUESTS_PER_MINUTE: Number(process.env.TELEMETRY_RATE_LIMIT_RPM ?? '60'),
} as const;

export type TelemetryConfig = typeof TELEMETRY_CONFIG;

// Validação de configuração na inicialização
export function validateTelemetryConfig(): void {
  const config = TELEMETRY_CONFIG;
  
  if (config.THROTTLE_INTERVAL_MS < 1000) {
    console.warn('[Telemetry Config] THROTTLE_INTERVAL_MS muito baixo, usando 1000ms');
  }
  
  if (config.MIN_UPDATE_INTERVAL_MS < 1000) {
    console.warn('[Telemetry Config] MIN_UPDATE_INTERVAL_MS muito baixo, usando 1000ms');
  }
  
  if (config.MAX_SESSIONS_MEMORY < 10) {
    console.warn('[Telemetry Config] MAX_SESSIONS_MEMORY muito baixo, usando 10');
  }
  
  console.log('[Telemetry Config] Configuração carregada:', {
    throttleMs: config.THROTTLE_INTERVAL_MS,
    minUpdateMs: config.MIN_UPDATE_INTERVAL_MS,
    maxSessions: config.MAX_SESSIONS_MEMORY,
    detailedLogs: config.ENABLE_DETAILED_LOGS,
    rateLimiting: config.ENABLE_RATE_LIMITING,
  });
}

// Validadores de dados
export function isValidPower(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= TELEMETRY_CONFIG.MAX_POWER_KW;
}

export function isValidVoltage(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= TELEMETRY_CONFIG.MAX_VOLTAGE_V;
}

export function isValidCurrent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= TELEMETRY_CONFIG.MAX_CURRENT_A;
}

export function isValidTemperature(value: number): boolean {
  return Number.isFinite(value) && 
         value >= TELEMETRY_CONFIG.MIN_TEMPERATURE_C && 
         value <= TELEMETRY_CONFIG.MAX_TEMPERATURE_C;
}

export function isValidSoC(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

export function isValidEnergy(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}