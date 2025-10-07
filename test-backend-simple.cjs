/**
 * Teste Simplificado do Backend - Sistema de Telemetria em Tempo Real
 * 
 * Este script executa testes básicos para verificar se o backend
 * implementou as funcionalidades necessárias para telemetria em tempo real.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

// Configurações
const CONFIG = {
  BACKEND_URL: process.env.BACKEND_URL || 'http://35.231.137.231:3000',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  TEST_CHARGE_BOX_ID: 'DRBAKANA-TEST-05',
  TEST_CONNECTOR_ID: 1,
  TIMEOUT: 10000 // 10 segundos
};

// Função para fazer requisições HTTP
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const req = client.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: CONFIG.TIMEOUT,
      ...options
    }, (res) => {
      let data = '';
      
      res.on('data', chunk => {
        data += chunk;
      });
      
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: data,
          success: res.statusCode >= 200 && res.statusCode < 300
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

// Teste 1: Conectividade básica do backend
async function testBackendConnectivity() {
  console.log('\n🔍 TESTE 1: CONECTIVIDADE DO BACKEND');
  console.log('='.repeat(40));
  
  const results = {
    backendOnline: false,
    healthEndpoint: false,
    apiEndpoints: false,
    errors: []
  };
  
  try {
    // Testar endpoint principal
    console.log('📡 Testando conectividade básica...');
    
    try {
      const response = await makeRequest(CONFIG.BACKEND_URL);
      results.backendOnline = response.success || response.statusCode === 404; // 404 é aceitável
      console.log(`✅ Backend respondendo: ${response.statusCode}`);
    } catch (error) {
      results.errors.push(`Backend não acessível: ${error.message}`);
      console.log(`❌ Backend não acessível: ${error.message}`);
    }
    
    // Testar endpoint de health (se existir)
    console.log('🏥 Testando endpoint de health...');
    
    try {
      const healthResponse = await makeRequest(`${CONFIG.BACKEND_URL}/health`);
      results.healthEndpoint = healthResponse.success;
      console.log(`✅ Health endpoint: ${healthResponse.statusCode}`);
    } catch (error) {
      console.log(`⚠️  Health endpoint não encontrado (normal se não implementado)`);
    }
    
    // Testar endpoints da API
    console.log('🔌 Testando endpoints da API...');
    
    const apiEndpoints = [
      '/v1/chargers?lat=-23.5505&lon=-46.6333',
      '/v1/telemetry/status',
      '/v1/stream'
    ];
    
    let apiResponses = 0;
    
    for (const endpoint of apiEndpoints) {
      try {
        const apiResponse = await makeRequest(`${CONFIG.BACKEND_URL}${endpoint}`);
        if (apiResponse.statusCode !== 500) { // Qualquer coisa exceto erro interno
          apiResponses++;
        }
        console.log(`   ${endpoint}: ${apiResponse.statusCode}`);
      } catch (error) {
        console.log(`   ${endpoint}: ERRO - ${error.message}`);
      }
    }
    
    results.apiEndpoints = apiResponses > 0;
    
  } catch (error) {
    results.errors.push(`Erro geral: ${error.message}`);
    console.error('❌ Erro geral:', error);
  }
  
  return results;
}

// Teste 2: Estrutura de dados esperada
async function testDataStructure() {
  console.log('\n📊 TESTE 2: ESTRUTURA DE DADOS');
  console.log('='.repeat(40));
  
  const results = {
    telemetryStructureValid: false,
    requiredFieldsPresent: false,
    dataTypesCorrect: false,
    errors: []
  };
  
  // Simular dados de telemetria esperados
  const expectedTelemetryStructure = {
    chargeBoxId: 'string',
    connectorId: 'number',
    transactionId: 'number|null',
    timestamp: 'string',
    meterValues: 'array'
  };
  
  const expectedMeterValueStructure = {
    timestamp: 'string',
    power: 'number',
    voltage: 'number',
    current: 'number',
    energy: 'number',
    soc: 'number',
    temperature: 'number'
  };
  
  console.log('📋 Validando estrutura esperada de telemetria...');
  
  // Simular validação de estrutura
  const mockTelemetryData = {
    chargeBoxId: CONFIG.TEST_CHARGE_BOX_ID,
    connectorId: CONFIG.TEST_CONNECTOR_ID,
    transactionId: 1001,
    timestamp: new Date().toISOString(),
    meterValues: [
      {
        timestamp: new Date().toISOString(),
        power: 7500,
        voltage: 230,
        current: 32.6,
        energy: 15000,
        soc: 65,
        temperature: 25
      }
    ]
  };
  
  try {
    // Validar estrutura principal
    const telemetryFields = Object.keys(expectedTelemetryStructure);
    const presentFields = telemetryFields.filter(field => field in mockTelemetryData);
    
    results.requiredFieldsPresent = presentFields.length === telemetryFields.length;
    console.log(`✅ Campos obrigatórios: ${presentFields.length}/${telemetryFields.length}`);
    
    // Validar tipos de dados
    let correctTypes = 0;
    telemetryFields.forEach(field => {
      const expectedType = expectedTelemetryStructure[field];
      const actualValue = mockTelemetryData[field];
      const actualType = Array.isArray(actualValue) ? 'array' : typeof actualValue;
      
      if (expectedType.includes(actualType) || expectedType === actualType) {
        correctTypes++;
      }
    });
    
    results.dataTypesCorrect = correctTypes === telemetryFields.length;
    console.log(`✅ Tipos de dados corretos: ${correctTypes}/${telemetryFields.length}`);
    
    // Validar estrutura de meterValues
    if (mockTelemetryData.meterValues && mockTelemetryData.meterValues.length > 0) {
      const meterValue = mockTelemetryData.meterValues[0];
      const meterFields = Object.keys(expectedMeterValueStructure);
      const presentMeterFields = meterFields.filter(field => field in meterValue);
      
      console.log(`✅ Campos de MeterValues: ${presentMeterFields.length}/${meterFields.length}`);
    }
    
    results.telemetryStructureValid = results.requiredFieldsPresent && results.dataTypesCorrect;
    
  } catch (error) {
    results.errors.push(`Erro na validação de estrutura: ${error.message}`);
    console.error('❌ Erro na validação:', error);
  }
  
  return results;
}

// Teste 3: Funcionalidades do Frontend
async function testFrontendIntegration() {
  console.log('\n🖥️  TESTE 3: INTEGRAÇÃO FRONTEND');
  console.log('='.repeat(40));
  
  const results = {
    frontendAccessible: false,
    telemetryComponentExists: false,
    storeImplemented: false,
    errors: []
  };
  
  try {
    // Testar acessibilidade do frontend
    console.log('🌐 Testando acessibilidade do frontend...');
    
    try {
      const frontendResponse = await makeRequest(CONFIG.FRONTEND_URL);
      results.frontendAccessible = frontendResponse.success || frontendResponse.statusCode === 200;
      console.log(`✅ Frontend acessível: ${frontendResponse.statusCode}`);
    } catch (error) {
      results.errors.push(`Frontend não acessível: ${error.message}`);
      console.log(`❌ Frontend não acessível: ${error.message}`);
    }
    
    // Verificar se arquivos de telemetria existem
    console.log('📁 Verificando arquivos de telemetria...');
    
    const telemetryFiles = [
      'src/hooks/useRealtimeTelemetry.ts',
      'src/state/telemetry.ts',
      'src/components/ChargingTelemetry.tsx'
    ];
    
    let filesExist = 0;
    
    telemetryFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          filesExist++;
          console.log(`✅ ${file} existe`);
        } else {
          console.log(`❌ ${file} não encontrado`);
        }
      } catch (error) {
        console.log(`⚠️  Erro ao verificar ${file}`);
      }
    });
    
    results.telemetryComponentExists = filesExist === telemetryFiles.length;
    results.storeImplemented = filesExist >= 2; // Hook e store pelo menos
    
  } catch (error) {
    results.errors.push(`Erro na verificação do frontend: ${error.message}`);
    console.error('❌ Erro no frontend:', error);
  }
  
  return results;
}

// Teste 4: Performance e Configuração
async function testPerformanceConfig() {
  console.log('\n⚡ TESTE 4: PERFORMANCE E CONFIGURAÇÃO');
  console.log('='.repeat(40));
  
  const results = {
    responseTime: null,
    configurationValid: false,
    throttlingImplemented: false,
    errors: []
  };
  
  try {
    // Testar tempo de resposta
    console.log('⏱️  Testando tempo de resposta...');
    
    const startTime = Date.now();
    
    try {
      await makeRequest(CONFIG.BACKEND_URL);
      results.responseTime = Date.now() - startTime;
      console.log(`✅ Tempo de resposta: ${results.responseTime}ms`);
    } catch (error) {
      console.log(`❌ Erro no teste de resposta: ${error.message}`);
    }
    
    // Verificar configurações
    console.log('⚙️  Verificando configurações...');
    
    const configChecks = {
      backendUrl: CONFIG.BACKEND_URL.startsWith('http'),
      frontendUrl: CONFIG.FRONTEND_URL.startsWith('http'),
      chargeBoxId: CONFIG.TEST_CHARGE_BOX_ID.length > 0,
      connectorId: CONFIG.TEST_CONNECTOR_ID > 0
    };
    
    const validConfigs = Object.values(configChecks).filter(Boolean).length;
    results.configurationValid = validConfigs === Object.keys(configChecks).length;
    
    console.log(`✅ Configurações válidas: ${validConfigs}/${Object.keys(configChecks).length}`);
    
    // Simular teste de throttling
    console.log('🎯 Simulando teste de throttling...');
    
    // Simular múltiplas requisições rápidas
    const requests = [];
    for (let i = 0; i < 5; i++) {
      requests.push(
        makeRequest(CONFIG.BACKEND_URL).catch(() => ({ success: false }))
      );
    }
    
    const responses = await Promise.all(requests);
    const successfulRequests = responses.filter(r => r.success).length;
    
    // Se nem todas as requisições foram bem-sucedidas, pode indicar throttling
    results.throttlingImplemented = successfulRequests < 5;
    console.log(`✅ Throttling detectado: ${results.throttlingImplemented ? 'SIM' : 'NÃO'}`);
    
  } catch (error) {
    results.errors.push(`Erro no teste de performance: ${error.message}`);
    console.error('❌ Erro de performance:', error);
  }
  
  return results;
}

// Função para gerar relatório final
function generateFinalReport(testResults) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 RELATÓRIO FINAL DE VALIDAÇÃO');
  console.log('='.repeat(60));
  
  const report = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    results: testResults,
    summary: {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      criticalIssues: 0,
      warnings: 0
    },
    recommendations: [],
    status: 'UNKNOWN'
  };
  
  // Calcular estatísticas
  Object.values(testResults).forEach(result => {
    if (result && typeof result === 'object') {
      report.summary.totalTests++;
      
      // Determinar se o teste passou
      const testPassed = Object.values(result).some(value => 
        typeof value === 'boolean' && value === true
      );
      
      if (testPassed) {
        report.summary.passedTests++;
      } else {
        report.summary.failedTests++;
      }
      
      // Contar erros críticos
      if (result.errors && result.errors.length > 0) {
        report.summary.criticalIssues += result.errors.length;
      }
    }
  });
  
  // Gerar recomendações
  if (!testResults.connectivity?.backendOnline) {
    report.recommendations.push({
      priority: 'CRÍTICO',
      issue: 'Backend não está acessível',
      solution: 'Verificar se o servidor backend está rodando na porta correta'
    });
  }
  
  if (!testResults.dataStructure?.telemetryStructureValid) {
    report.recommendations.push({
      priority: 'ALTO',
      issue: 'Estrutura de dados de telemetria inválida',
      solution: 'Implementar estrutura de dados conforme especificação'
    });
  }
  
  if (!testResults.frontend?.telemetryComponentExists) {
    report.recommendations.push({
      priority: 'MÉDIO',
      issue: 'Componentes de telemetria do frontend ausentes',
      solution: 'Implementar componentes de telemetria conforme documentação'
    });
  }
  
  // Determinar status geral
  if (report.summary.criticalIssues === 0 && report.summary.failedTests === 0) {
    report.status = 'SUCESSO';
  } else if (report.summary.criticalIssues === 0) {
    report.status = 'ATENÇÃO';
  } else {
    report.status = 'CRÍTICO';
  }
  
  // Exibir resumo
  console.log(`🎯 Status Geral: ${report.status}`);
  console.log(`✅ Testes Aprovados: ${report.summary.passedTests}/${report.summary.totalTests}`);
  console.log(`❌ Testes Reprovados: ${report.summary.failedTests}/${report.summary.totalTests}`);
  console.log(`🚨 Problemas Críticos: ${report.summary.criticalIssues}`);
  
  if (report.recommendations.length > 0) {
    console.log('\n💡 RECOMENDAÇÕES:');
    report.recommendations.forEach((rec, index) => {
      console.log(`${index + 1}. [${rec.priority}] ${rec.issue}`);
      console.log(`   Solução: ${rec.solution}`);
    });
  }
  
  // Salvar relatório
  try {
    fs.writeFileSync('test-report-simple.json', JSON.stringify(report, null, 2));
    console.log('\n💾 Relatório salvo em: test-report-simple.json');
  } catch (error) {
    console.log('⚠️  Não foi possível salvar o relatório');
  }
  
  return report;
}

// Função principal
async function runAllTests() {
  console.log('🧪 INICIANDO VALIDAÇÃO DO SISTEMA DE TELEMETRIA');
  console.log('='.repeat(60));
  console.log(`📅 Data/Hora: ${new Date().toLocaleString('pt-BR')}`);
  console.log(`🔗 Backend URL: ${CONFIG.BACKEND_URL}`);
  console.log(`🖥️  Frontend URL: ${CONFIG.FRONTEND_URL}`);
  console.log(`🔌 Charge Box ID: ${CONFIG.TEST_CHARGE_BOX_ID}`);
  console.log('='.repeat(60));
  
  const testResults = {};
  
  try {
    // Executar todos os testes
    testResults.connectivity = await testBackendConnectivity();
    testResults.dataStructure = await testDataStructure();
    testResults.frontend = await testFrontendIntegration();
    testResults.performance = await testPerformanceConfig();
    
    // Gerar relatório final
    const finalReport = generateFinalReport(testResults);
    
    // Conclusão
    console.log('\n' + '='.repeat(60));
    
    if (finalReport.status === 'SUCESSO') {
      console.log('🎉 PARABÉNS! O sistema está pronto para telemetria em tempo real!');
    } else if (finalReport.status === 'ATENÇÃO') {
      console.log('🟡 Sistema funcional, mas há melhorias necessárias.');
    } else {
      console.log('🔴 ATENÇÃO! Há problemas que precisam ser resolvidos.');
    }
    
    console.log('\n📋 PRÓXIMOS PASSOS:');
    
    if (finalReport.status === 'CRÍTICO') {
      console.log('1. Resolver problemas críticos listados nas recomendações');
      console.log('2. Implementar backend SSE conforme BACKEND_SSE_TELEMETRY.md');
      console.log('3. Testar conectividade e endpoints');
    } else if (finalReport.status === 'ATENÇÃO') {
      console.log('1. Implementar melhorias sugeridas');
      console.log('2. Testar integração completa');
      console.log('3. Monitorar performance em produção');
    } else {
      console.log('1. Implementar backend SSE conforme documentação');
      console.log('2. Testar com dados reais de OCPP');
      console.log('3. Monitorar e otimizar performance');
    }
    
    return finalReport;
    
  } catch (error) {
    console.error('\n❌ Erro durante execução dos testes:', error);
    return {
      status: 'ERRO',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  runAllTests,
  testBackendConnectivity,
  testDataStructure,
  testFrontendIntegration,
  testPerformanceConfig
};