/**
 * Testes Automatizados de Validação de API - Sistema CSMS IGE2A
 * 
 * Este módulo valida automaticamente:
 * - Configuração correta de API keys
 * - Endpoints com roteamento correto
 * - Autenticação e autorização
 * - Estrutura de resposta da API
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

// Configurações de teste
const API_CONFIG = {
  LOCAL_URL: process.env.LOCAL_BACKEND_URL || 'http://localhost:3000',
  VM_URL: process.env.VM_BACKEND_URL || 'http://35.231.137.231:3000',
  API_KEY: process.env.API_KEY || 'minha_chave_super_secreta',
  TIMEOUT: 10000,
  TEST_LAT: -23.5505,
  TEST_LON: -46.6333,
  TEST_CHARGE_BOX_ID: 'DRBAKANA-TEST-06'
};

// Endpoints a serem testados
const ENDPOINTS_TO_TEST = [
  {
    name: 'Health Check',
    path: '/health',
    method: 'GET',
    requiresAuth: false,
    expectedStatus: 200,
    critical: true
  },
  {
    name: 'List Chargers',
    path: `/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: true,
    expectedStatus: 200,
    critical: true,
    validateResponse: (data) => Array.isArray(data) && data.length >= 0
  },
  {
    name: 'Get Specific Charger',
    path: `/v1/chargers/${API_CONFIG.TEST_CHARGE_BOX_ID}`,
    method: 'GET',
    requiresAuth: true,
    expectedStatus: 200,
    critical: true,
    validateResponse: (data) => data && data.chargeBoxId === API_CONFIG.TEST_CHARGE_BOX_ID
  },
  {
    name: 'Telemetry Status',
    path: '/v1/telemetry/status',
    method: 'GET',
    requiresAuth: true,
    expectedStatus: 200,
    critical: false,
    validateResponse: (data) => data && data.system
  },
  {
    name: 'SSE Stream',
    path: '/v1/stream',
    method: 'GET',
    requiresAuth: false,
    expectedStatus: 200,
    critical: false,
    isSSE: true
  }
];

// Endpoints incorretos que devem falhar
const INCORRECT_ENDPOINTS = [
  {
    name: 'Incorrect API Route - /api/v1/chargers',
    path: `/api/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: true,
    expectedStatus: 404,
    shouldFail: true
  },
  {
    name: 'Missing API Key',
    path: `/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: false, // Não enviar API key
    expectedStatus: 401,
    shouldFail: true
  },
  {
    name: 'Invalid API Key',
    path: `/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: true,
    apiKey: 'invalid_key_123',
    expectedStatus: 401,
    shouldFail: true
  }
];

// Função para fazer requisições HTTP
function makeRequest(baseUrl, endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.path, baseUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'CSMS-IGE2A-API-Validator/1.0'
    };

    // Adicionar API key se necessário
    if (endpoint.requiresAuth) {
      headers['X-API-Key'] = options.apiKey || endpoint.apiKey || API_CONFIG.API_KEY;
    }

    // Headers especiais para SSE
    if (endpoint.isSSE) {
      headers['Accept'] = 'text/event-stream';
      headers['Cache-Control'] = 'no-cache';
    }
    
    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: endpoint.method,
      headers: headers,
      timeout: API_CONFIG.TIMEOUT
    };

    const req = client.request(requestOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        let parsedData = null;
        
        try {
          if (data && !endpoint.isSSE) {
            parsedData = JSON.parse(data);
          }
        } catch (e) {
          // Dados não são JSON válido, manter como string
        }
        
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsedData,
          rawData: data,
          success: res.statusCode === endpoint.expectedStatus
        });
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      if (endpoint.isSSE) {
        // Para SSE, timeout pode indicar conexão bem-sucedida
        resolve({
          status: 200,
          success: true,
          note: 'SSE connection established (timeout reached)'
        });
      } else {
        reject(new Error('Request timeout'));
      }
    });

    req.end();
  });
}

// Função para testar um endpoint específico
async function testEndpoint(baseUrl, endpoint, context = '') {
  const testName = `${context}${endpoint.name}`;
  
  try {
    console.log(`🧪 Testando: ${testName}`);
    console.log(`   📡 ${endpoint.method} ${endpoint.path}`);
    
    const result = await makeRequest(baseUrl, endpoint);
    
    const statusMatch = result.status === endpoint.expectedStatus;
    const validationPassed = endpoint.validateResponse ? 
      endpoint.validateResponse(result.data) : true;
    
    const success = statusMatch && validationPassed;
    
    if (success) {
      console.log(`   ✅ Status: ${result.status} (esperado: ${endpoint.expectedStatus})`);
      if (endpoint.validateResponse && validationPassed) {
        console.log(`   ✅ Validação de resposta: PASSOU`);
      }
    } else {
      console.log(`   ❌ Status: ${result.status} (esperado: ${endpoint.expectedStatus})`);
      if (endpoint.validateResponse && !validationPassed) {
        console.log(`   ❌ Validação de resposta: FALHOU`);
      }
    }
    
    return {
      endpoint: testName,
      path: endpoint.path,
      method: endpoint.method,
      expectedStatus: endpoint.expectedStatus,
      actualStatus: result.status,
      success: endpoint.shouldFail ? !success : success,
      critical: endpoint.critical || false,
      requiresAuth: endpoint.requiresAuth,
      validationPassed,
      data: result.data,
      error: null
    };
    
  } catch (error) {
    console.log(`   ❌ Erro: ${error.message}`);
    
    return {
      endpoint: testName,
      path: endpoint.path,
      method: endpoint.method,
      expectedStatus: endpoint.expectedStatus,
      actualStatus: null,
      success: false,
      critical: endpoint.critical || false,
      requiresAuth: endpoint.requiresAuth,
      validationPassed: false,
      data: null,
      error: error.message
    };
  }
}

// Função para testar configuração de API Key
async function testAPIKeyConfiguration(baseUrl) {
  console.log('\n🔑 TESTANDO CONFIGURAÇÃO DE API KEY');
  console.log('='.repeat(50));
  
  const results = [];
  
  // Teste 1: Endpoint protegido sem API key
  const withoutKey = {
    name: 'Endpoint protegido SEM API key',
    path: `/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: false,
    expectedStatus: 401,
    shouldFail: true
  };
  
  results.push(await testEndpoint(baseUrl, withoutKey, '🔒 '));
  
  // Teste 2: Endpoint protegido com API key incorreta
  const withWrongKey = {
    name: 'Endpoint protegido COM API key INCORRETA',
    path: `/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: true,
    apiKey: 'chave_incorreta_123',
    expectedStatus: 401,
    shouldFail: true
  };
  
  results.push(await testEndpoint(baseUrl, withWrongKey, '🔒 '));
  
  // Teste 3: Endpoint protegido com API key correta
  const withCorrectKey = {
    name: 'Endpoint protegido COM API key CORRETA',
    path: `/v1/chargers?lat=${API_CONFIG.TEST_LAT}&lon=${API_CONFIG.TEST_LON}`,
    method: 'GET',
    requiresAuth: true,
    expectedStatus: 200
  };
  
  results.push(await testEndpoint(baseUrl, withCorrectKey, '🔓 '));
  
  return results;
}

// Função para testar roteamento correto
async function testCorrectRouting(baseUrl) {
  console.log('\n🛣️  TESTANDO ROTEAMENTO CORRETO');
  console.log('='.repeat(50));
  
  const results = [];
  
  // Testar endpoints corretos
  for (const endpoint of ENDPOINTS_TO_TEST) {
    results.push(await testEndpoint(baseUrl, endpoint, '✅ '));
  }
  
  return results;
}

// Função para testar endpoints incorretos
async function testIncorrectRouting(baseUrl) {
  console.log('\n🚫 TESTANDO ENDPOINTS INCORRETOS (devem falhar)');
  console.log('='.repeat(50));
  
  const results = [];
  
  for (const endpoint of INCORRECT_ENDPOINTS) {
    results.push(await testEndpoint(baseUrl, endpoint, '❌ '));
  }
  
  return results;
}

// Função principal de validação de API
async function runAPIValidationTests(targetUrl = null) {
  const testUrl = targetUrl || API_CONFIG.LOCAL_URL;
  
  console.log('🔍 INICIANDO VALIDAÇÃO AUTOMÁTICA DE API');
  console.log('='.repeat(60));
  console.log(`🎯 URL de teste: ${testUrl}`);
  console.log(`🔑 API Key: ${API_CONFIG.API_KEY.substring(0, 12)}...`);
  console.log('');

  const results = {
    timestamp: new Date().toISOString(),
    testUrl: testUrl,
    apiKey: API_CONFIG.API_KEY,
    tests: {
      apiKeyConfiguration: [],
      correctRouting: [],
      incorrectRouting: []
    },
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      critical: 0
    }
  };

  try {
    // Executar todos os testes
    results.tests.apiKeyConfiguration = await testAPIKeyConfiguration(testUrl);
    results.tests.correctRouting = await testCorrectRouting(testUrl);
    results.tests.incorrectRouting = await testIncorrectRouting(testUrl);

    // Calcular estatísticas
    const allTests = [
      ...results.tests.apiKeyConfiguration,
      ...results.tests.correctRouting,
      ...results.tests.incorrectRouting
    ];

    results.summary.total = allTests.length;
    results.summary.passed = allTests.filter(test => test.success).length;
    results.summary.failed = allTests.filter(test => !test.success).length;
    results.summary.critical = allTests.filter(test => !test.success && test.critical).length;

    // Exibir resumo
    console.log('\n' + '='.repeat(60));
    console.log('📊 RESUMO DA VALIDAÇÃO DE API');
    console.log('='.repeat(60));
    console.log(`✅ Testes aprovados: ${results.summary.passed}/${results.summary.total}`);
    console.log(`❌ Testes reprovados: ${results.summary.failed}/${results.summary.total}`);
    console.log(`🚨 Problemas críticos: ${results.summary.critical}`);

    // Listar problemas críticos
    const criticalIssues = allTests.filter(test => !test.success && test.critical);
    if (criticalIssues.length > 0) {
      console.log('\n🚨 PROBLEMAS CRÍTICOS ENCONTRADOS:');
      criticalIssues.forEach(issue => {
        console.log(`   - ${issue.endpoint}: ${issue.error || 'Falha na validação'}`);
      });
    }

    // Salvar relatório
    const reportFile = 'api-validation-report.json';
    fs.writeFileSync(reportFile, JSON.stringify(results, null, 2));
    console.log(`\n💾 Relatório salvo em: ${reportFile}`);

  } catch (error) {
    console.error('\n❌ Erro durante validação de API:', error);
    results.error = error.message;
  }

  return results;
}

// Função para validar ambos os ambientes (local e VM)
async function runFullAPIValidation() {
  console.log('🌐 VALIDAÇÃO COMPLETA DE API - LOCAL E VM');
  console.log('='.repeat(70));

  const results = {
    timestamp: new Date().toISOString(),
    environments: {
      local: null,
      vm: null
    },
    comparison: null
  };

  // Testar ambiente local
  console.log('\n🏠 TESTANDO AMBIENTE LOCAL');
  console.log('='.repeat(40));
  try {
    results.environments.local = await runAPIValidationTests(API_CONFIG.LOCAL_URL);
  } catch (error) {
    console.log(`❌ Erro no ambiente local: ${error.message}`);
    results.environments.local = { error: error.message };
  }

  // Testar ambiente VM
  console.log('\n☁️  TESTANDO AMBIENTE VM LINUX');
  console.log('='.repeat(40));
  try {
    results.environments.vm = await runAPIValidationTests(API_CONFIG.VM_URL);
  } catch (error) {
    console.log(`❌ Erro no ambiente VM: ${error.message}`);
    results.environments.vm = { error: error.message };
  }

  // Comparar resultados
  if (results.environments.local && results.environments.vm && 
      !results.environments.local.error && !results.environments.vm.error) {
    
    results.comparison = {
      localPassed: results.environments.local.summary.passed,
      vmPassed: results.environments.vm.summary.passed,
      consistent: results.environments.local.summary.passed === results.environments.vm.summary.passed,
      localCritical: results.environments.local.summary.critical,
      vmCritical: results.environments.vm.summary.critical
    };

    console.log('\n🔄 COMPARAÇÃO ENTRE AMBIENTES');
    console.log('='.repeat(40));
    console.log(`🏠 Local: ${results.comparison.localPassed} testes aprovados`);
    console.log(`☁️  VM: ${results.comparison.vmPassed} testes aprovados`);
    console.log(`🎯 Consistência: ${results.comparison.consistent ? 'SIM' : 'NÃO'}`);
  }

  // Salvar relatório completo
  const fullReportFile = 'full-api-validation-report.json';
  fs.writeFileSync(fullReportFile, JSON.stringify(results, null, 2));
  console.log(`\n💾 Relatório completo salvo em: ${fullReportFile}`);

  return results;
}

// Exportar funções
module.exports = {
  runAPIValidationTests,
  runFullAPIValidation,
  testAPIKeyConfiguration,
  testCorrectRouting,
  testIncorrectRouting,
  API_CONFIG,
  ENDPOINTS_TO_TEST,
  INCORRECT_ENDPOINTS
};

// Executar se chamado diretamente
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--full')) {
    runFullAPIValidation()
      .then(results => {
        const success = results.environments.local && results.environments.vm &&
                       results.environments.local.summary.critical === 0 &&
                       results.environments.vm.summary.critical === 0;
        
        process.exit(success ? 0 : 1);
      })
      .catch(error => {
        console.error('💥 ERRO CRÍTICO:', error);
        process.exit(1);
      });
  } else {
    const targetUrl = args[0] || API_CONFIG.LOCAL_URL;
    runAPIValidationTests(targetUrl)
      .then(results => {
        process.exit(results.summary.critical === 0 ? 0 : 1);
      })
      .catch(error => {
        console.error('💥 ERRO CRÍTICO:', error);
        process.exit(1);
      });
  }
}