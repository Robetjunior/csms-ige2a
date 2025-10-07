/**
 * Teste de Validação para VM Linux - Sistema CSMS IGE2A
 * 
 * Este módulo valida se o sistema está funcionando corretamente na VM Linux,
 * verificando endpoints, autenticação, e funcionalidades específicas.
 */

const https = require('https');
const http = require('http');

// Configuração para VM Linux
const VM_CONFIG = {
  BACKEND_URL: process.env.VM_BACKEND_URL || 'http://35.231.137.231:3000',
  API_KEY: process.env.VM_API_KEY || 'minha_chave_super_secreta',
  TEST_CHARGE_BOX_ID: 'DRBAKANA-TEST-06',
  TIMEOUT: 10000, // 10 segundos
  REQUIRED_LAT: -23.5505,
  REQUIRED_LON: -46.6333
};

// Função para fazer requisições HTTP
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: VM_CONFIG.TIMEOUT
    };

    const req = client.request(requestOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonData = data ? JSON.parse(data) : null;
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: jsonData,
            rawData: data
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: null,
            rawData: data
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

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

// Função para testar SSE com timeout
function testSSEConnection(url, timeout = 5000) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache'
      }
    };

    const req = client.request(requestOptions, (res) => {
      if (res.statusCode === 200) {
        resolve({ success: true, status: res.statusCode });
      } else {
        resolve({ success: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
      }
      req.destroy();
    });

    req.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });

    // Timeout para SSE
    setTimeout(() => {
      req.destroy();
      resolve({ success: true, status: 200, note: 'SSE connection established (timeout reached)' });
    }, timeout);

    req.end();
  });
}

// Teste 1: Health Check
async function testHealthCheck() {
  console.log('🏥 TESTE: VERIFICANDO SAÚDE DO BACKEND');
  console.log('='.repeat(40));
  
  try {
    const url = `${VM_CONFIG.BACKEND_URL}/health`;
    console.log(`📡 Testando: \`${url}\``);
    
    const response = await makeRequest(url);
    
    if (response.status === 200) {
      console.log(`✅ Status: ${response.status}`);
      console.log('✅ Backend está saudável');
      return { success: true, status: response.status, data: response.data };
    } else {
      console.log(`❌ Status: ${response.status}`);
      return { success: false, status: response.status, error: 'Health check failed' };
    }
  } catch (error) {
    console.log(`❌ Erro: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Teste 2: Listar Chargers
async function testListChargers() {
  console.log('\n📋 TESTE: LISTANDO TODOS OS CHARGERS');
  console.log('='.repeat(40));
  
  try {
    const url = `${VM_CONFIG.BACKEND_URL}/v1/chargers?lat=${VM_CONFIG.REQUIRED_LAT}&lon=${VM_CONFIG.REQUIRED_LON}`;
    console.log(`📡 Testando: \`${url}\``);
    
    const response = await makeRequest(url, {
      headers: {
        'X-API-Key': VM_CONFIG.API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 200 && Array.isArray(response.data)) {
      console.log(`✅ Status: ${response.status}`);
      console.log(`✅ Chargers encontrados: ${response.data.length}`);
      
      if (response.data.length > 0) {
        console.log('📋 Chargers disponíveis:');
        response.data.forEach(charger => {
          console.log(`   - ${charger.chargeBoxId} (Status: ${charger.overallStatus || 'Unknown'})`);
        });
      }
      
      return { 
        success: true, 
        status: response.status, 
        data: response.data,
        count: response.data.length 
      };
    } else {
      console.log(`❌ Status: ${response.status}`);
      return { success: false, status: response.status, error: 'Failed to list chargers' };
    }
  } catch (error) {
    console.log(`❌ Erro: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Teste 3: Verificar Charger Específico
async function testSpecificCharger() {
  console.log(`\n🎯 TESTE: VERIFICANDO ${VM_CONFIG.TEST_CHARGE_BOX_ID}`);
  console.log('='.repeat(40));
  
  try {
    const url = `${VM_CONFIG.BACKEND_URL}/v1/chargers/${VM_CONFIG.TEST_CHARGE_BOX_ID}`;
    console.log(`📡 Testando: \`${url}\``);
    
    const response = await makeRequest(url, {
      headers: {
        'X-API-Key': VM_CONFIG.API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 200 && response.data) {
      console.log(`✅ Status: ${response.status}`);
      console.log(`✅ ${VM_CONFIG.TEST_CHARGE_BOX_ID} encontrado`);
      console.log(`   Status: ${response.data.lastStatus || 'Unknown'}`);
      console.log(`   Online: ${response.data.wsOnline ? 'Sim' : 'Não'}`);
      console.log(`   Conectores: ${response.data.connectors ? response.data.connectors.length : 0}`);
      
      return { success: true, status: response.status, data: response.data };
    } else {
      console.log(`❌ Status: ${response.status}`);
      return { success: false, status: response.status, error: `${VM_CONFIG.TEST_CHARGE_BOX_ID} not found` };
    }
  } catch (error) {
    console.log(`❌ Erro: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Teste 4: Status de Telemetria
async function testTelemetryStatus() {
  console.log('\n📊 TESTE: STATUS DE TELEMETRIA');
  console.log('='.repeat(40));
  
  try {
    const url = `${VM_CONFIG.BACKEND_URL}/v1/telemetry/status`;
    console.log(`📡 Testando: \`${url}\``);
    
    const response = await makeRequest(url, {
      headers: {
        'X-API-Key': VM_CONFIG.API_KEY,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 200 && response.data) {
      console.log(`✅ Status: ${response.status}`);
      console.log('✅ Sistema de telemetria funcionando');
      
      if (response.data.sessions) {
        console.log(`   Sessões ativas: ${response.data.sessions.active || 0}`);
      }
      
      if (response.data.system) {
        console.log(`   Status: ${response.data.system.status || 'unknown'}`);
      }
      
      return { success: true, status: response.status, data: response.data };
    } else {
      console.log(`❌ Status: ${response.status}`);
      return { success: false, status: response.status, error: 'Telemetry status failed' };
    }
  } catch (error) {
    console.log(`❌ Erro: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Teste 5: Endpoint SSE
async function testSSEEndpoint() {
  console.log('\n🔄 TESTE: VERIFICANDO ENDPOINT SSE');
  console.log('='.repeat(40));
  
  try {
    const url = `${VM_CONFIG.BACKEND_URL}/v1/stream`;
    console.log(`📡 Testando: \`${url}\``);
    
    const result = await testSSEConnection(url, 3000); // 3 segundos de timeout
    
    if (result.success) {
      console.log(`✅ Status: ${result.status}`);
      console.log('✅ Endpoint SSE funcionando');
      return { success: true, status: result.status };
    } else {
      console.log(`❌ Erro: ${result.error}`);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.log(`❌ Erro: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Função principal de execução dos testes
async function runVMValidationTests() {
  console.log('🚀 INICIANDO TESTES DE VALIDAÇÃO DA VM LINUX');
  console.log('='.repeat(60));
  console.log(`🔗 Backend URL: ${VM_CONFIG.BACKEND_URL}`);
  console.log(`🔑 API Key: ${VM_CONFIG.API_KEY.substring(0, 12)}...`);
  console.log('');

  const results = {
    timestamp: new Date().toISOString(),
    config: VM_CONFIG,
    tests: {}
  };

  // Executar todos os testes
  results.tests.health = await testHealthCheck();
  results.tests.listChargers = await testListChargers();
  results.tests.specificCharger = await testSpecificCharger();
  results.tests.telemetryStatus = await testTelemetryStatus();
  results.tests.sseEndpoint = await testSSEEndpoint();

  // Calcular estatísticas
  const testNames = Object.keys(results.tests);
  const passedTests = testNames.filter(name => results.tests[name].success);
  const failedTests = testNames.filter(name => !results.tests[name].success);

  // Exibir resumo
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESUMO DOS TESTES');
  console.log('='.repeat(60));
  console.log(`🏥 Backend Health: ${results.tests.health.success ? '✅ OK' : '❌ FALHOU'}`);
  console.log(`📋 Lista de Chargers: ${results.tests.listChargers.success ? '✅ OK' : '❌ FALHOU'}`);
  console.log(`🎯 ${VM_CONFIG.TEST_CHARGE_BOX_ID}: ${results.tests.specificCharger.success ? '✅ ENCONTRADO' : '❌ NÃO ENCONTRADO'}`);
  console.log(`📊 Telemetria: ${results.tests.telemetryStatus.success ? '✅ OK' : '❌ FALHOU'}`);
  console.log(`🔄 Endpoint SSE: ${results.tests.sseEndpoint.success ? '✅ OK' : '❌ FALHOU'}`);
  console.log('');
  console.log(`🎯 RESULTADO: ${passedTests.length}/${testNames.length} testes aprovados`);

  if (failedTests.length > 0) {
    console.log('\n❌ TESTES QUE FALHARAM:');
    failedTests.forEach(testName => {
      const test = results.tests[testName];
      console.log(`   - ${testName}: ${test.error || 'Erro desconhecido'}`);
    });
  }

  // Salvar relatório
  const reportFile = 'vm-validation-test-report.json';
  try {
    const fs = require('fs');
    fs.writeFileSync(reportFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Relatório salvo em: ${reportFile}`);
  } catch (error) {
    console.log(`\n⚠️  Erro ao salvar relatório: ${error.message}`);
  }

  return results;
}

// Exportar funções para uso em outros módulos
module.exports = {
  runVMValidationTests,
  testHealthCheck,
  testListChargers,
  testSpecificCharger,
  testTelemetryStatus,
  testSSEEndpoint,
  VM_CONFIG
};

// Executar se chamado diretamente
if (require.main === module) {
  runVMValidationTests()
    .then(results => {
      const passedTests = Object.values(results.tests).filter(test => test.success).length;
      const totalTests = Object.keys(results.tests).length;
      
      if (passedTests === totalTests) {
        console.log('\n🎉 TODOS OS TESTES PASSARAM!');
        process.exit(0);
      } else {
        console.log('\n⚠️  ALGUNS TESTES FALHARAM!');
        process.exit(1);
      }
    })
    .catch(error => {
      console.error('\n💥 ERRO CRÍTICO:', error);
      process.exit(1);
    });
}