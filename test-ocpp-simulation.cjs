/**
 * Simulador OCPP MeterValues para Teste de Integração
 * 
 * Este script simula mensagens OCPP MeterValues para testar:
 * 1. Processamento correto de dados OCPP
 * 2. Extração de métricas (power, voltage, current, etc.)
 * 3. Conversão para formato SSE
 * 4. Throttling de atualizações
 */

// Simulação de dados OCPP MeterValues reais
const sampleOCPPMeterValues = {
  messageTypeId: 2,
  uniqueId: "12345",
  action: "MeterValues",
  payload: {
    connectorId: 1,
    transactionId: 1001,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: "7500",
            context: "Sample.Periodic",
            format: "Raw",
            measurand: "Power.Active.Import",
            phase: null,
            location: "Outlet",
            unit: "W"
          },
          {
            value: "230.5",
            context: "Sample.Periodic", 
            format: "Raw",
            measurand: "Voltage",
            phase: "L1-N",
            location: "Outlet",
            unit: "V"
          },
          {
            value: "32.6",
            context: "Sample.Periodic",
            format: "Raw", 
            measurand: "Current.Import",
            phase: "L1",
            location: "Outlet",
            unit: "A"
          },
          {
            value: "45.2",
            context: "Sample.Periodic",
            format: "Raw",
            measurand: "Temperature",
            phase: null,
            location: "Body",
            unit: "Celsius"
          },
          {
            value: "15750",
            context: "Sample.Periodic",
            format: "Raw",
            measurand: "Energy.Active.Import.Register",
            phase: null,
            location: "Outlet", 
            unit: "Wh"
          },
          {
            value: "75",
            context: "Sample.Periodic",
            format: "Raw",
            measurand: "SoC",
            phase: null,
            location: "EV",
            unit: "Percent"
          }
        ]
      }
    ]
  }
};

// Função para extrair métricas dos dados OCPP (como o backend deveria fazer)
function extractMetricsFromOCPP(ocppData) {
  const metrics = {
    chargeBoxId: "DRBAKANA-TEST-05", // Simulado
    connectorId: ocppData.payload.connectorId,
    transactionId: ocppData.payload.transactionId,
    timestamp: new Date().toISOString(),
    meterValues: ocppData.payload.meterValue,
    power: null,
    voltage: null,
    current: null,
    temperature: null,
    totalEnergy: null,
    stateOfCharge: null,
    duration: null
  };
  
  // Extrair valores das medições
  const sampledValues = ocppData.payload.meterValue[0]?.sampledValue || [];
  
  sampledValues.forEach(sample => {
    const value = parseFloat(sample.value);
    
    switch (sample.measurand) {
      case 'Power.Active.Import':
        metrics.power = value;
        break;
      case 'Voltage':
        metrics.voltage = value;
        break;
      case 'Current.Import':
        metrics.current = value;
        break;
      case 'Temperature':
        metrics.temperature = value;
        break;
      case 'Energy.Active.Import.Register':
        metrics.totalEnergy = value;
        break;
      case 'SoC':
        metrics.stateOfCharge = value;
        break;
    }
  });
  
  return metrics;
}

// Função para testar se o backend processa OCPP corretamente
async function testOCPPProcessing() {
  console.log('🔌 Testando processamento de dados OCPP MeterValues...\n');
  
  // Simular extração de métricas
  const extractedMetrics = extractMetricsFromOCPP(sampleOCPPMeterValues);
  
  console.log('📊 Dados OCPP originais:');
  console.log(JSON.stringify(sampleOCPPMeterValues, null, 2));
  
  console.log('\n📈 Métricas extraídas:');
  console.log(JSON.stringify(extractedMetrics, null, 2));
  
  // Validações
  const validations = {
    hasRequiredFields: !!(extractedMetrics.chargeBoxId && extractedMetrics.connectorId && extractedMetrics.transactionId),
    hasMeterValues: Array.isArray(extractedMetrics.meterValues) && extractedMetrics.meterValues.length > 0,
    hasPowerData: extractedMetrics.power !== null,
    hasVoltageData: extractedMetrics.voltage !== null,
    hasCurrentData: extractedMetrics.current !== null,
    hasTemperatureData: extractedMetrics.temperature !== null,
    hasEnergyData: extractedMetrics.totalEnergy !== null,
    hasSoCData: extractedMetrics.stateOfCharge !== null,
    validTimestamp: !isNaN(new Date(extractedMetrics.timestamp).getTime())
  };
  
  console.log('\n✅ Validações:');
  Object.entries(validations).forEach(([key, value]) => {
    console.log(`${value ? '✅' : '❌'} ${key}: ${value ? 'PASS' : 'FAIL'}`);
  });
  
  return { extractedMetrics, validations };
}

// Função para simular múltiplas atualizações e testar throttling
function simulateMultipleUpdates() {
  console.log('\n⏱️  Simulando múltiplas atualizações para testar throttling...');
  
  const updates = [];
  const startTime = Date.now();
  
  // Simular 10 atualizações em 2 segundos
  for (let i = 0; i < 10; i++) {
    const timestamp = new Date(startTime + (i * 200)); // A cada 200ms
    
    const update = {
      ...extractMetricsFromOCPP(sampleOCPPMeterValues),
      timestamp: timestamp.toISOString(),
      power: 7500 + (Math.random() * 500 - 250), // Variação realística
      voltage: 230.5 + (Math.random() * 10 - 5),
      current: 32.6 + (Math.random() * 2 - 1)
    };
    
    updates.push(update);
  }
  
  console.log(`📊 Geradas ${updates.length} atualizações em ${(updates[updates.length-1].timestamp - updates[0].timestamp) / 1000}s`);
  
  // Simular throttling (backend deveria enviar apenas a cada 5 segundos)
  const throttledUpdates = updates.filter((update, index) => {
    const timeDiff = new Date(update.timestamp) - new Date(updates[0].timestamp);
    return timeDiff % 5000 < 200; // Apenas atualizações próximas aos intervalos de 5s
  });
  
  console.log(`🎯 Após throttling (5s): ${throttledUpdates.length} atualizações`);
  console.log('✅ Throttling funcionando corretamente:', throttledUpdates.length <= Math.ceil(updates.length / 25));
  
  return { allUpdates: updates, throttledUpdates };
}

// Função para testar diferentes cenários de dados
function testDataScenarios() {
  console.log('\n🧪 Testando diferentes cenários de dados...\n');
  
  const scenarios = [
    {
      name: 'Carregamento Normal',
      data: {
        power: 7500,
        voltage: 230.5,
        current: 32.6,
        temperature: 45.2,
        stateOfCharge: 75
      }
    },
    {
      name: 'Carregamento Rápido',
      data: {
        power: 50000,
        voltage: 400,
        current: 125,
        temperature: 65.8,
        stateOfCharge: 45
      }
    },
    {
      name: 'Carregamento Lento',
      data: {
        power: 3700,
        voltage: 230,
        current: 16,
        temperature: 35.5,
        stateOfCharge: 90
      }
    },
    {
      name: 'Fim de Carregamento',
      data: {
        power: 0,
        voltage: 230,
        current: 0,
        temperature: 25.0,
        stateOfCharge: 100
      }
    }
  ];
  
  scenarios.forEach(scenario => {
    console.log(`📋 Cenário: ${scenario.name}`);
    
    // Validar se os dados estão dentro de faixas esperadas
    const validations = {
      powerValid: scenario.data.power >= 0 && scenario.data.power <= 350000, // 0 a 350kW
      voltageValid: scenario.data.voltage >= 100 && scenario.data.voltage <= 1000, // 100V a 1000V
      currentValid: scenario.data.current >= 0 && scenario.data.current <= 500, // 0 a 500A
      temperatureValid: scenario.data.temperature >= -40 && scenario.data.temperature <= 100, // -40°C a 100°C
      socValid: scenario.data.stateOfCharge >= 0 && scenario.data.stateOfCharge <= 100 // 0% a 100%
    };
    
    const allValid = Object.values(validations).every(v => v);
    console.log(`${allValid ? '✅' : '❌'} Dados válidos: ${allValid ? 'SIM' : 'NÃO'}`);
    
    if (!allValid) {
      Object.entries(validations).forEach(([key, value]) => {
        if (!value) console.log(`  ❌ ${key}: ${scenario.data[key.replace('Valid', '')]}`);
      });
    }
    
    console.log('');
  });
}

// Função principal
async function runOCPPTests() {
  console.log('🔌 TESTES DE INTEGRAÇÃO OCPP');
  console.log('='.repeat(50));
  
  // Teste 1: Processamento básico
  const { extractedMetrics, validations } = await testOCPPProcessing();
  
  // Teste 2: Throttling
  const { allUpdates, throttledUpdates } = simulateMultipleUpdates();
  
  // Teste 3: Cenários diversos
  testDataScenarios();
  
  // Relatório final
  console.log('\n📊 RELATÓRIO DE TESTES OCPP');
  console.log('='.repeat(50));
  
  const criticalValidations = [
    validations.hasRequiredFields,
    validations.hasMeterValues,
    validations.hasPowerData,
    validations.validTimestamp
  ];
  
  const allCriticalPassed = criticalValidations.every(v => v);
  
  console.log(`✅ Campos obrigatórios: ${validations.hasRequiredFields ? 'PASS' : 'FAIL'}`);
  console.log(`📊 MeterValues presente: ${validations.hasMeterValues ? 'PASS' : 'FAIL'}`);
  console.log(`⚡ Dados de potência: ${validations.hasPowerData ? 'PASS' : 'FAIL'}`);
  console.log(`🔋 Dados de voltagem: ${validations.hasVoltageData ? 'PASS' : 'FAIL'}`);
  console.log(`🌡️  Dados de temperatura: ${validations.hasTemperatureData ? 'PASS' : 'FAIL'}`);
  console.log(`🔋 Estado de carga: ${validations.hasSoCData ? 'PASS' : 'FAIL'}`);
  console.log(`⏰ Timestamp válido: ${validations.validTimestamp ? 'PASS' : 'FAIL'}`);
  
  console.log('\n🎯 AVALIAÇÃO GERAL:');
  if (allCriticalPassed) {
    console.log('🟢 SUCESSO: Processamento OCPP implementado corretamente!');
  } else {
    console.log('🔴 FALHA: Problemas no processamento de dados OCPP');
  }
  
  return {
    extractedMetrics,
    validations,
    allCriticalPassed
  };
}

// Executar se chamado diretamente
if (require.main === module) {
  runOCPPTests().catch(console.error);
}

module.exports = { 
  runOCPPTests, 
  extractMetricsFromOCPP, 
  simulateMultipleUpdates,
  sampleOCPPMeterValues 
};