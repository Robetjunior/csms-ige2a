/**
 * Teste de Validação de Dados de Telemetria
 * 
 * Este script valida a estrutura, qualidade e integridade dos dados
 * de telemetria recebidos via SSE do backend.
 */

const EventSource = require('eventsource');

// Configurações
const CONFIG = {
  BACKEND_URL: process.env.BACKEND_URL || 'http://35.231.137.231:3000',
  SSE_ENDPOINT: '/v1/stream',
  TEST_DURATION: 30000, // 30 segundos
  MIN_SAMPLES: 5,
  MAX_SAMPLES: 100
};

// Esquemas de validação
const TELEMETRY_SCHEMA = {
  required: ['chargeBoxId', 'connectorId', 'timestamp', 'meterValues'],
  optional: ['transactionId', 'sessionDuration'],
  meterValues: {
    required: ['timestamp'],
    optional: ['power', 'voltage', 'current', 'energy', 'soc', 'temperature']
  }
};

// Validadores de dados
const validators = {
  chargeBoxId: (value) => typeof value === 'string' && value.length > 0,
  connectorId: (value) => Number.isInteger(value) && value > 0,
  transactionId: (value) => value === null || (Number.isInteger(value) && value > 0),
  timestamp: (value) => {
    const date = new Date(value);
    return !isNaN(date.getTime()) && date.getTime() <= Date.now();
  },
  power: (value) => typeof value === 'number' && value >= 0 && value <= 50000, // 0-50kW
  voltage: (value) => typeof value === 'number' && value >= 100 && value <= 500, // 100-500V
  current: (value) => typeof value === 'number' && value >= 0 && value <= 200, // 0-200A
  energy: (value) => typeof value === 'number' && value >= 0,
  soc: (value) => typeof value === 'number' && value >= 0 && value <= 100, // 0-100%
  temperature: (value) => typeof value === 'number' && value >= -40 && value <= 80, // -40 a 80°C
  sessionDuration: (value) => typeof value === 'number' && value >= 0
};

// Classe para análise de dados
class TelemetryDataAnalyzer {
  constructor() {
    this.samples = [];
    this.errors = [];
    this.warnings = [];
    this.statistics = {
      totalSamples: 0,
      validSamples: 0,
      invalidSamples: 0,
      missingFields: {},
      invalidValues: {},
      dataQuality: {
        completeness: 0,
        accuracy: 0,
        consistency: 0,
        timeliness: 0
      }
    };
  }

  addSample(data) {
    this.samples.push({
      timestamp: Date.now(),
      data: data,
      validation: this.validateSample(data)
    });
    this.statistics.totalSamples++;
  }

  validateSample(data) {
    const validation = {
      isValid: true,
      errors: [],
      warnings: [],
      missingRequired: [],
      invalidValues: []
    };

    try {
      // Validar estrutura básica
      if (!data || typeof data !== 'object') {
        validation.errors.push('Dados não são um objeto válido');
        validation.isValid = false;
        return validation;
      }

      // Validar campos obrigatórios
      TELEMETRY_SCHEMA.required.forEach(field => {
        if (!(field in data)) {
          validation.missingRequired.push(field);
          validation.errors.push(`Campo obrigatório ausente: ${field}`);
          validation.isValid = false;
        }
      });

      // Validar valores dos campos
      Object.keys(data).forEach(field => {
        if (validators[field]) {
          if (!validators[field](data[field])) {
            validation.invalidValues.push({
              field,
              value: data[field],
              expected: this.getExpectedFormat(field)
            });
            validation.errors.push(`Valor inválido para ${field}: ${data[field]}`);
            validation.isValid = false;
          }
        }
      });

      // Validar meterValues se presente
      if (data.meterValues) {
        const meterValidation = this.validateMeterValues(data.meterValues);
        validation.errors.push(...meterValidation.errors);
        validation.warnings.push(...meterValidation.warnings);
        if (!meterValidation.isValid) {
          validation.isValid = false;
        }
      }

      // Validações de consistência
      this.validateConsistency(data, validation);

      // Validações de qualidade temporal
      this.validateTimeliness(data, validation);

    } catch (error) {
      validation.errors.push(`Erro durante validação: ${error.message}`);
      validation.isValid = false;
    }

    return validation;
  }

  validateMeterValues(meterValues) {
    const validation = {
      isValid: true,
      errors: [],
      warnings: []
    };

    if (!Array.isArray(meterValues)) {
      validation.errors.push('meterValues deve ser um array');
      validation.isValid = false;
      return validation;
    }

    meterValues.forEach((meter, index) => {
      // Validar timestamp obrigatório
      if (!meter.timestamp) {
        validation.errors.push(`meterValues[${index}]: timestamp obrigatório`);
        validation.isValid = false;
      }

      // Validar valores opcionais
      TELEMETRY_SCHEMA.meterValues.optional.forEach(field => {
        if (field in meter && validators[field]) {
          if (!validators[field](meter[field])) {
            validation.errors.push(`meterValues[${index}].${field}: valor inválido ${meter[field]}`);
            validation.isValid = false;
          }
        }
      });

      // Avisos para valores suspeitos
      if (meter.power && meter.power > 22000) {
        validation.warnings.push(`meterValues[${index}]: Potência muito alta (${meter.power}W)`);
      }

      if (meter.soc && meter.soc < 5) {
        validation.warnings.push(`meterValues[${index}]: SoC muito baixo (${meter.soc}%)`);
      }
    });

    return validation;
  }

  validateConsistency(data, validation) {
    // Verificar consistência entre power, voltage e current
    if (data.meterValues) {
      data.meterValues.forEach((meter, index) => {
        if (meter.power && meter.voltage && meter.current) {
          const calculatedPower = meter.voltage * meter.current;
          const powerDifference = Math.abs(meter.power - calculatedPower) / meter.power;
          
          if (powerDifference > 0.1) { // 10% de tolerância
            validation.warnings.push(
              `meterValues[${index}]: Inconsistência P=V*I (P=${meter.power}W, V*I=${calculatedPower.toFixed(2)}W)`
            );
          }
        }
      });
    }
  }

  validateTimeliness(data, validation) {
    const now = Date.now();
    const dataTime = new Date(data.timestamp).getTime();
    const timeDiff = now - dataTime;

    // Dados muito antigos (>5 minutos)
    if (timeDiff > 300000) {
      validation.warnings.push(`Dados antigos: ${Math.round(timeDiff/1000)}s de atraso`);
    }

    // Dados do futuro
    if (timeDiff < -1000) {
      validation.errors.push(`Timestamp no futuro: ${Math.round(-timeDiff/1000)}s`);
      validation.isValid = false;
    }
  }

  getExpectedFormat(field) {
    const formats = {
      chargeBoxId: 'string não vazia',
      connectorId: 'inteiro positivo',
      transactionId: 'inteiro positivo ou null',
      timestamp: 'ISO 8601 string',
      power: 'número 0-50000 (Watts)',
      voltage: 'número 100-500 (Volts)',
      current: 'número 0-200 (Amperes)',
      energy: 'número positivo (Wh)',
      soc: 'número 0-100 (percentual)',
      temperature: 'número -40 a 80 (Celsius)',
      sessionDuration: 'número positivo (segundos)'
    };
    return formats[field] || 'formato desconhecido';
  }

  calculateStatistics() {
    const validSamples = this.samples.filter(s => s.validation.isValid);
    this.statistics.validSamples = validSamples.length;
    this.statistics.invalidSamples = this.samples.length - validSamples.length;

    // Calcular completeness (campos presentes vs esperados)
    const totalFields = TELEMETRY_SCHEMA.required.length + TELEMETRY_SCHEMA.optional.length;
    let totalFieldsPresent = 0;

    this.samples.forEach(sample => {
      const fieldsPresent = Object.keys(sample.data).length;
      totalFieldsPresent += fieldsPresent;
    });

    this.statistics.dataQuality.completeness = this.samples.length > 0 
      ? (totalFieldsPresent / (this.samples.length * totalFields)) * 100 
      : 0;

    // Calcular accuracy (dados válidos vs total)
    this.statistics.dataQuality.accuracy = this.samples.length > 0 
      ? (this.statistics.validSamples / this.samples.length) * 100 
      : 0;

    // Calcular consistency (variação temporal)
    if (validSamples.length > 1) {
      const timestamps = validSamples.map(s => new Date(s.data.timestamp).getTime());
      const intervals = [];
      
      for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i] - timestamps[i-1]);
      }
      
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((sum, interval) => sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
      const consistency = Math.max(0, 100 - (Math.sqrt(variance) / avgInterval * 100));
      
      this.statistics.dataQuality.consistency = consistency;
    }

    // Calcular timeliness (atraso médio)
    const now = Date.now();
    let totalDelay = 0;
    
    validSamples.forEach(sample => {
      const dataTime = new Date(sample.data.timestamp).getTime();
      const delay = now - dataTime;
      totalDelay += Math.max(0, delay);
    });

    const avgDelay = validSamples.length > 0 ? totalDelay / validSamples.length : 0;
    this.statistics.dataQuality.timeliness = Math.max(0, 100 - (avgDelay / 60000 * 10)); // Penalizar 10% por minuto de atraso

    return this.statistics;
  }

  generateReport() {
    const stats = this.calculateStatistics();
    
    return {
      summary: {
        totalSamples: stats.totalSamples,
        validSamples: stats.validSamples,
        invalidSamples: stats.invalidSamples,
        successRate: stats.totalSamples > 0 ? (stats.validSamples / stats.totalSamples * 100).toFixed(2) : 0
      },
      dataQuality: {
        completeness: stats.dataQuality.completeness.toFixed(2),
        accuracy: stats.dataQuality.accuracy.toFixed(2),
        consistency: stats.dataQuality.consistency.toFixed(2),
        timeliness: stats.dataQuality.timeliness.toFixed(2),
        overall: ((stats.dataQuality.completeness + stats.dataQuality.accuracy + 
                  stats.dataQuality.consistency + stats.dataQuality.timeliness) / 4).toFixed(2)
      },
      issues: {
        errors: this.samples.reduce((acc, s) => acc.concat(s.validation.errors), []),
        warnings: this.samples.reduce((acc, s) => acc.concat(s.validation.warnings), []),
        missingFields: this.getMissingFieldsStats(),
        invalidValues: this.getInvalidValuesStats()
      },
      recommendations: this.generateRecommendations(stats)
    };
  }

  getMissingFieldsStats() {
    const missing = {};
    this.samples.forEach(sample => {
      sample.validation.missingRequired.forEach(field => {
        missing[field] = (missing[field] || 0) + 1;
      });
    });
    return missing;
  }

  getInvalidValuesStats() {
    const invalid = {};
    this.samples.forEach(sample => {
      sample.validation.invalidValues.forEach(item => {
        if (!invalid[item.field]) {
          invalid[item.field] = [];
        }
        invalid[item.field].push(item.value);
      });
    });
    return invalid;
  }

  generateRecommendations(stats) {
    const recommendations = [];

    if (stats.dataQuality.accuracy < 90) {
      recommendations.push({
        priority: 'ALTO',
        issue: 'Taxa de dados válidos baixa',
        solution: 'Revisar validação e processamento de dados OCPP no backend'
      });
    }

    if (stats.dataQuality.completeness < 80) {
      recommendations.push({
        priority: 'MÉDIO',
        issue: 'Muitos campos ausentes nos dados',
        solution: 'Verificar extração completa de dados dos MeterValues OCPP'
      });
    }

    if (stats.dataQuality.consistency < 70) {
      recommendations.push({
        priority: 'MÉDIO',
        issue: 'Inconsistência temporal nos dados',
        solution: 'Implementar throttling mais efetivo e sincronização de timestamps'
      });
    }

    if (stats.dataQuality.timeliness < 80) {
      recommendations.push({
        priority: 'ALTO',
        issue: 'Dados com muito atraso',
        solution: 'Otimizar pipeline de processamento e reduzir latência'
      });
    }

    return recommendations;
  }
}

// Função principal de teste
async function runDataValidationTests() {
  console.log('\n📊 TESTE DE VALIDAÇÃO DE DADOS DE TELEMETRIA');
  console.log('='.repeat(50));
  
  const analyzer = new TelemetryDataAnalyzer();
  const sseUrl = `${CONFIG.BACKEND_URL}${CONFIG.SSE_ENDPOINT}`;
  
  console.log(`🔗 Conectando a: ${sseUrl}`);
  console.log(`⏱️  Duração do teste: ${CONFIG.TEST_DURATION/1000}s`);
  console.log(`📈 Amostras esperadas: ${CONFIG.MIN_SAMPLES}-${CONFIG.MAX_SAMPLES}`);
  
  return new Promise((resolve) => {
    const eventSource = new EventSource(sseUrl);
    let testStartTime = Date.now();
    let samplesReceived = 0;
    
    const timeout = setTimeout(() => {
      eventSource.close();
      
      console.log('\n⏰ Tempo de teste esgotado');
      console.log(`📊 Amostras coletadas: ${samplesReceived}`);
      
      const report = analyzer.generateReport();
      
      // Exibir resultados
      console.log('\n📋 RESULTADOS DA VALIDAÇÃO');
      console.log('='.repeat(40));
      console.log(`✅ Amostras válidas: ${report.summary.validSamples}/${report.summary.totalSamples} (${report.summary.successRate}%)`);
      console.log(`❌ Amostras inválidas: ${report.summary.invalidSamples}`);
      
      console.log('\n🎯 QUALIDADE DOS DADOS');
      console.log('='.repeat(40));
      console.log(`📊 Completude: ${report.dataQuality.completeness}%`);
      console.log(`🎯 Precisão: ${report.dataQuality.accuracy}%`);
      console.log(`🔄 Consistência: ${report.dataQuality.consistency}%`);
      console.log(`⏱️  Pontualidade: ${report.dataQuality.timeliness}%`);
      console.log(`🏆 Qualidade Geral: ${report.dataQuality.overall}%`);
      
      if (report.issues.errors.length > 0) {
        console.log('\n❌ ERROS ENCONTRADOS:');
        report.issues.errors.slice(0, 5).forEach(error => {
          console.log(`   • ${error}`);
        });
        if (report.issues.errors.length > 5) {
          console.log(`   ... e mais ${report.issues.errors.length - 5} erros`);
        }
      }
      
      if (report.issues.warnings.length > 0) {
        console.log('\n⚠️  AVISOS:');
        report.issues.warnings.slice(0, 3).forEach(warning => {
          console.log(`   • ${warning}`);
        });
        if (report.issues.warnings.length > 3) {
          console.log(`   ... e mais ${report.issues.warnings.length - 3} avisos`);
        }
      }
      
      // Determinar resultado final
      const overallQuality = parseFloat(report.dataQuality.overall);
      const success = overallQuality >= 80 && report.summary.validSamples >= CONFIG.MIN_SAMPLES;
      
      console.log(`\n🏁 RESULTADO FINAL: ${success ? '✅ APROVADO' : '❌ REPROVADO'}`);
      
      resolve({
        success,
        report,
        details: `Qualidade geral: ${report.dataQuality.overall}%, Amostras válidas: ${report.summary.validSamples}/${report.summary.totalSamples}`
      });
      
    }, CONFIG.TEST_DURATION);
    
    eventSource.onopen = () => {
      console.log('✅ Conexão SSE estabelecida');
    };
    
    eventSource.addEventListener('telemetry.updated', (event) => {
      try {
        const data = JSON.parse(event.data);
        analyzer.addSample(data);
        samplesReceived++;
        
        if (samplesReceived % 5 === 0) {
          console.log(`📊 Amostras coletadas: ${samplesReceived}`);
        }
        
        if (samplesReceived >= CONFIG.MAX_SAMPLES) {
          clearTimeout(timeout);
          eventSource.close();
          
          const report = analyzer.generateReport();
          console.log(`\n✅ Limite de amostras atingido (${CONFIG.MAX_SAMPLES})`);
          
          resolve({
            success: true,
            report,
            details: `${CONFIG.MAX_SAMPLES} amostras coletadas com sucesso`
          });
        }
        
      } catch (error) {
        console.error('❌ Erro ao processar evento:', error);
        analyzer.addSample({ error: error.message });
      }
    });
    
    eventSource.onerror = (error) => {
      console.error('❌ Erro na conexão SSE:', error);
      clearTimeout(timeout);
      eventSource.close();
      
      resolve({
        success: false,
        report: null,
        details: 'Falha na conexão SSE'
      });
    };
  });
}

// Exportar para uso em outros scripts
module.exports = {
  runDataValidationTests,
  TelemetryDataAnalyzer,
  validators,
  TELEMETRY_SCHEMA
};

// Executar se chamado diretamente
if (require.main === module) {
  runDataValidationTests().catch(console.error);
}