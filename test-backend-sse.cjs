/**
 * Script de Teste para Backend SSE - Telemetria em Tempo Real
 * 
 * Este script testa se o backend implementou corretamente:
 * 1. Endpoint SSE /v1/stream
 * 2. Eventos telemetry.updated
 * 3. Estrutura correta dos dados
 * 4. Integração com OCPP MeterValues
 */

const { EventSource } = require('eventsource');
const fetch = require('node-fetch');

// Configurações de teste
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const SSE_ENDPOINT = `${BACKEND_URL}/v1/stream`;
const TEST_TIMEOUT = 30000; // 30 segundos

console.log('🧪 Iniciando testes do Backend SSE para Telemetria');
console.log(`📡 Conectando ao endpoint: ${SSE_ENDPOINT}`);

// Estrutura esperada do evento telemetry.updated
const expectedTelemetryStructure = {
  chargeBoxId: 'string',
  connectorId: 'number',
  transactionId: 'number',
  timestamp: 'string',
  meterValues: 'array',
  // Campos opcionais
  power: 'number',
  voltage: 'number', 
  current: 'number',
  temperature: 'number',
  totalEnergy: 'number',
  stateOfCharge: 'number',
  duration: 'number'
};

let testResults = {
  connectionEstablished: false,
  heartbeatReceived: false,
  telemetryEventReceived: false,
  dataStructureValid: false,
  meterValuesPresent: false,
  timestampValid: false,
  requiredFieldsPresent: false,
  errors: []
};

function validateTelemetryData(data) {
  const errors = [];
  
  // Verificar campos obrigatórios
  const requiredFields = ['chargeBoxId', 'connectorId', 'transactionId', 'timestamp', 'meterValues'];
  
  for (const field of requiredFields) {
    if (!(field in data)) {
      errors.push(`Campo obrigatório ausente: ${field}`);
    }
  }
  
  // Verificar tipos de dados
  if (typeof data.chargeBoxId !== 'string') {
    errors.push('chargeBoxId deve ser string');
  }
  
  if (typeof data.connectorId !== 'number') {
    errors.push('connectorId deve ser number');
  }
  
  if (typeof data.transactionId !== 'number') {
    errors.push('transactionId deve ser number');
  }
  
  if (!Array.isArray(data.meterValues)) {
    errors.push('meterValues deve ser array');
  }
  
  // Verificar timestamp
  const timestamp = new Date(data.timestamp);
  if (isNaN(timestamp.getTime())) {
    errors.push('timestamp inválido');
  }
  
  // Verificar se pelo menos um valor de medição está presente
  const measurementFields = ['power', 'voltage', 'current', 'temperature', 'totalEnergy', 'stateOfCharge'];
  const hasMeasurement = measurementFields.some(field => field in data && typeof data[field] === 'number');
  
  if (!hasMeasurement) {
    errors.push('Nenhum campo de medição (power, voltage, current, etc.) encontrado');
  }
  
  return errors;
}

function runSSETest() {
  return new Promise((resolve, reject) => {
    const eventSource = new EventSource(SSE_ENDPOINT);
    
    const timeout = setTimeout(() => {
      eventSource.close();
      testResults.errors.push('Timeout: Nenhum evento recebido em 30 segundos');
      resolve(testResults);
    }, TEST_TIMEOUT);
    
    eventSource.onopen = () => {
      console.log('✅ Conexão SSE estabelecida');
      testResults.connectionEstablished = true;
    };
    
    eventSource.onerror = (error) => {
      console.error('❌ Erro na conexão SSE:', error);
      testResults.errors.push(`Erro de conexão: ${error.message || 'Erro desconhecido'}`);
      clearTimeout(timeout);
      eventSource.close();
      resolve(testResults);
    };
    
    // Listener para eventos de heartbeat
    eventSource.addEventListener('heartbeat', (event) => {
      console.log('💓 Heartbeat recebido');
      testResults.heartbeatReceived = true;
    });
    
    // Listener principal para eventos de telemetria
    eventSource.addEventListener('telemetry.updated', (event) => {
      console.log('📊 Evento telemetry.updated recebido');
      testResults.telemetryEventReceived = true;
      
      try {
        const data = JSON.parse(event.data);
        console.log('📋 Dados recebidos:', JSON.stringify(data, null, 2));
        
        // Validar estrutura dos dados
        const validationErrors = validateTelemetryData(data);
        
        if (validationErrors.length === 0) {
          testResults.dataStructureValid = true;
          testResults.requiredFieldsPresent = true;
          testResults.meterValuesPresent = Array.isArray(data.meterValues) && data.meterValues.length > 0;
          testResults.timestampValid = !isNaN(new Date(data.timestamp).getTime());
          
          console.log('✅ Estrutura de dados válida');
          console.log(`✅ MeterValues presente: ${testResults.meterValuesPresent}`);
          console.log(`✅ Timestamp válido: ${testResults.timestampValid}`);
        } else {
          testResults.errors.push(...validationErrors);
          console.log('❌ Erros na estrutura de dados:', validationErrors);
        }
        
      } catch (parseError) {
        testResults.errors.push(`Erro ao parsear JSON: ${parseError.message}`);
        console.error('❌ Erro ao parsear dados:', parseError);
      }
      
      // Fechar conexão após receber dados de telemetria
      clearTimeout(timeout);
      eventSource.close();
      resolve(testResults);
    });
    
    // Listener genérico para outros eventos
    eventSource.onmessage = (event) => {
      console.log('📨 Evento genérico recebido:', event.type, event.data);
    };
  });
}

// Função para testar conectividade básica do backend
async function testBackendConnectivity() {
  console.log('\n🔍 Testando conectividade básica do backend...');
  
  try {
    const response = await fetch(`${BACKEND_URL}/health`);
    if (response.ok) {
      console.log('✅ Backend respondendo (endpoint /health)');
      return true;
    }
  } catch (error) {
    console.log('⚠️  Endpoint /health não disponível, tentando endpoint SSE diretamente');
  }
  
  return false;
}

// Função principal de teste
async function runAllTests() {
  console.log('🚀 Iniciando bateria de testes completa...\n');
  
  // Teste 1: Conectividade básica
  await testBackendConnectivity();
  
  // Teste 2: SSE e Telemetria
  console.log('\n📡 Testando endpoint SSE e eventos de telemetria...');
  const results = await runSSETest();
  
  // Relatório final
  console.log('\n📊 RELATÓRIO DE TESTES');
  console.log('='.repeat(50));
  
  console.log(`✅ Conexão SSE estabelecida: ${results.connectionEstablished ? 'SIM' : 'NÃO'}`);
  console.log(`💓 Heartbeat recebido: ${results.heartbeatReceived ? 'SIM' : 'NÃO'}`);
  console.log(`📊 Evento telemetry.updated: ${results.telemetryEventReceived ? 'SIM' : 'NÃO'}`);
  console.log(`📋 Estrutura de dados válida: ${results.dataStructureValid ? 'SIM' : 'NÃO'}`);
  console.log(`🔢 Campos obrigatórios presentes: ${results.requiredFieldsPresent ? 'SIM' : 'NÃO'}`);
  console.log(`📈 MeterValues presente: ${results.meterValuesPresent ? 'SIM' : 'NÃO'}`);
  console.log(`⏰ Timestamp válido: ${results.timestampValid ? 'SIM' : 'NÃO'}`);
  
  if (results.errors.length > 0) {
    console.log('\n❌ ERROS ENCONTRADOS:');
    results.errors.forEach((error, index) => {
      console.log(`${index + 1}. ${error}`);
    });
  }
  
  // Avaliação geral
  const criticalTests = [
    results.connectionEstablished,
    results.telemetryEventReceived,
    results.dataStructureValid
  ];
  
  const allCriticalPassed = criticalTests.every(test => test);
  
  console.log('\n🎯 AVALIAÇÃO GERAL:');
  if (allCriticalPassed && results.errors.length === 0) {
    console.log('🟢 SUCESSO: Backend implementado corretamente para telemetria em tempo real!');
  } else if (allCriticalPassed) {
    console.log('🟡 PARCIAL: Funcionalidade básica implementada, mas há melhorias necessárias');
  } else {
    console.log('🔴 FALHA: Backend não está funcionando corretamente para telemetria em tempo real');
  }
  
  console.log('\n📝 PRÓXIMOS PASSOS:');
  if (!results.connectionEstablished) {
    console.log('- Verificar se o backend está rodando e acessível');
    console.log('- Confirmar se o endpoint /v1/stream está implementado');
  }
  if (!results.telemetryEventReceived) {
    console.log('- Implementar eventos telemetry.updated no backend');
    console.log('- Verificar integração com OCPP MeterValues');
  }
  if (!results.dataStructureValid) {
    console.log('- Corrigir estrutura dos dados de telemetria');
    console.log('- Seguir especificação em BACKEND_SSE_TELEMETRY.md');
  }
}

// Executar testes
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = { runAllTests, validateTelemetryData };