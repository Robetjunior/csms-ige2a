/**
 * Teste de Integração Frontend - Telemetria em Tempo Real
 * 
 * Este script testa:
 * 1. Hook useRealtimeTelemetry funcionando
 * 2. Componente ChargingTelemetry atualizando
 * 3. Store de telemetria funcionando
 * 4. Indicadores visuais corretos
 * 5. Fallback para polling
 */

const puppeteer = require('puppeteer');

// Configurações de teste
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const TEST_CHARGE_BOX_ID = 'DRBAKANA-TEST-05';
const TEST_CONNECTOR_ID = 1;
const TEST_TIMEOUT = 30000;

// Dados de teste para simular SSE
const mockTelemetryData = {
  chargeBoxId: TEST_CHARGE_BOX_ID,
  connectorId: TEST_CONNECTOR_ID,
  transactionId: 1001,
  timestamp: new Date().toISOString(),
  meterValues: [
    {
      timestamp: new Date().toISOString(),
      sampledValue: [
        { value: "7500", measurand: "Power.Active.Import", unit: "W" },
        { value: "230.5", measurand: "Voltage", unit: "V" },
        { value: "32.6", measurand: "Current.Import", unit: "A" }
      ]
    }
  ],
  power: 7500,
  voltage: 230.5,
  current: 32.6,
  temperature: 45.2,
  totalEnergy: 15750,
  stateOfCharge: 75,
  duration: 1800
};

async function testFrontendIntegration() {
  console.log('🖥️  Iniciando testes de integração frontend...\n');
  
  let browser;
  let testResults = {
    pageLoaded: false,
    telemetryComponentFound: false,
    useRealtimeTelemetryWorking: false,
    telemetryStoreWorking: false,
    realTimeIndicatorPresent: false,
    pollingFallbackWorking: false,
    dataDisplayedCorrectly: false,
    errors: []
  };
  
  try {
    // Iniciar browser
    browser = await puppeteer.launch({ 
      headless: false, // Para visualizar os testes
      devtools: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Interceptar console logs
    page.on('console', msg => {
      console.log(`🖥️  Console: ${msg.text()}`);
    });
    
    // Interceptar erros
    page.on('pageerror', error => {
      testResults.errors.push(`Erro na página: ${error.message}`);
      console.error('❌ Erro na página:', error.message);
    });
    
    // Navegar para a página de telemetria
    const telemetryUrl = `${FRONTEND_URL}/cp/${TEST_CHARGE_BOX_ID}`;
    console.log(`📱 Navegando para: ${telemetryUrl}`);
    
    await page.goto(telemetryUrl, { waitUntil: 'networkidle0' });
    testResults.pageLoaded = true;
    console.log('✅ Página carregada');
    
    // Aguardar componente de telemetria carregar
    try {
      await page.waitForSelector('[data-testid="charging-telemetry"], .charging-telemetry', { timeout: 10000 });
      testResults.telemetryComponentFound = true;
      console.log('✅ Componente ChargingTelemetry encontrado');
    } catch (error) {
      testResults.errors.push('Componente ChargingTelemetry não encontrado');
      console.log('❌ Componente ChargingTelemetry não encontrado');
    }
    
    // Verificar se o hook useRealtimeTelemetry está funcionando
    const hookStatus = await page.evaluate(() => {
      // Verificar se o store de telemetria existe
      if (window.telemetryStore) {
        return { storeExists: true };
      }
      
      // Verificar se há indicadores de tempo real na página
      const realtimeIndicators = document.querySelectorAll('[data-testid="realtime-indicator"], .realtime-indicator');
      const pollingIndicators = document.querySelectorAll('[data-testid="polling-indicator"], .polling-indicator');
      
      return {
        storeExists: false,
        realtimeIndicators: realtimeIndicators.length,
        pollingIndicators: pollingIndicators.length
      };
    });
    
    if (hookStatus.storeExists) {
      testResults.telemetryStoreWorking = true;
      console.log('✅ Store de telemetria funcionando');
    }
    
    if (hookStatus.realtimeIndicators > 0 || hookStatus.pollingIndicators > 0) {
      testResults.realTimeIndicatorPresent = true;
      console.log('✅ Indicadores de tempo real/polling presentes');
    }
    
    // Simular dados SSE chegando
    console.log('📡 Simulando dados SSE...');
    
    await page.evaluate((mockData) => {
      // Simular evento SSE
      if (window.telemetryStore && window.telemetryStore.getState) {
        const store = window.telemetryStore.getState();
        if (store.updateTelemetry) {
          store.updateTelemetry(
            mockData.chargeBoxId,
            mockData.connectorId,
            mockData.transactionId,
            mockData
          );
          console.log('Dados de telemetria simulados injetados no store');
        }
      }
      
      // Disparar evento customizado para simular SSE
      const event = new CustomEvent('telemetry-updated', { detail: mockData });
      window.dispatchEvent(event);
    }, mockTelemetryData);
    
    // Aguardar um pouco para os dados serem processados
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verificar se os dados estão sendo exibidos
    const displayedData = await page.evaluate(() => {
      const powerElements = document.querySelectorAll('[data-testid="power-value"], .power-value');
      const voltageElements = document.querySelectorAll('[data-testid="voltage-value"], .voltage-value');
      const currentElements = document.querySelectorAll('[data-testid="current-value"], .current-value');
      const socElements = document.querySelectorAll('[data-testid="soc-value"], .soc-value');
      
      return {
        powerDisplayed: powerElements.length > 0,
        voltageDisplayed: voltageElements.length > 0,
        currentDisplayed: currentElements.length > 0,
        socDisplayed: socElements.length > 0,
        powerValue: powerElements[0]?.textContent || '',
        voltageValue: voltageElements[0]?.textContent || '',
        currentValue: currentElements[0]?.textContent || '',
        socValue: socElements[0]?.textContent || ''
      };
    });
    
    if (displayedData.powerDisplayed || displayedData.voltageDisplayed) {
      testResults.dataDisplayedCorrectly = true;
      console.log('✅ Dados de telemetria sendo exibidos');
      console.log(`   Potência: ${displayedData.powerValue}`);
      console.log(`   Voltagem: ${displayedData.voltageValue}`);
      console.log(`   Corrente: ${displayedData.currentValue}`);
      console.log(`   SoC: ${displayedData.socValue}`);
    } else {
      testResults.errors.push('Dados de telemetria não estão sendo exibidos');
      console.log('❌ Dados de telemetria não estão sendo exibidos');
    }
    
    // Testar fallback para polling
    console.log('🔄 Testando fallback para polling...');
    
    await page.evaluate(() => {
      // Simular desconexão SSE
      if (window.EventSource) {
        const originalEventSource = window.EventSource;
        window.EventSource = function() {
          throw new Error('SSE não disponível');
        };
        
        // Disparar evento de reconexão
        setTimeout(() => {
          window.EventSource = originalEventSource;
        }, 5000);
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const pollingStatus = await page.evaluate(() => {
      const pollingIndicators = document.querySelectorAll('[data-testid="polling-indicator"], .polling-indicator');
      const refreshButtons = document.querySelectorAll('[data-testid="refresh-button"], .refresh-button');
      
      return {
        pollingIndicatorVisible: pollingIndicators.length > 0,
        refreshButtonVisible: refreshButtons.length > 0
      };
    });
    
    if (pollingStatus.pollingIndicatorVisible || pollingStatus.refreshButtonVisible) {
      testResults.pollingFallbackWorking = true;
      console.log('✅ Fallback para polling funcionando');
    }
    
    // Capturar screenshot para análise visual
    await page.screenshot({ 
      path: 'frontend-telemetry-test.png',
      fullPage: true 
    });
    console.log('📸 Screenshot salvo como frontend-telemetry-test.png');
    
  } catch (error) {
    testResults.errors.push(`Erro geral: ${error.message}`);
    console.error('❌ Erro durante teste:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  return testResults;
}

// Função para testar responsividade
async function testResponsiveness() {
  console.log('\n📱 Testando responsividade...');
  
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  const viewports = [
    { width: 375, height: 667, name: 'iPhone SE' },
    { width: 414, height: 896, name: 'iPhone 11' },
    { width: 768, height: 1024, name: 'iPad' },
    { width: 1920, height: 1080, name: 'Desktop' }
  ];
  
  const results = [];
  
  for (const viewport of viewports) {
    await page.setViewport(viewport);
    await page.goto(`${FRONTEND_URL}/cp/${TEST_CHARGE_BOX_ID}`);
    
    const isResponsive = await page.evaluate(() => {
      const telemetryComponent = document.querySelector('[data-testid="charging-telemetry"], .charging-telemetry');
      if (!telemetryComponent) return false;
      
      const rect = telemetryComponent.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    
    results.push({
      viewport: viewport.name,
      responsive: isResponsive
    });
    
    console.log(`${isResponsive ? '✅' : '❌'} ${viewport.name}: ${isResponsive ? 'OK' : 'PROBLEMA'}`);
  }
  
  await browser.close();
  return results;
}

// Função principal
async function runFrontendTests() {
  console.log('🖥️  TESTES DE INTEGRAÇÃO FRONTEND');
  console.log('='.repeat(50));
  
  // Teste 1: Integração básica
  const integrationResults = await testFrontendIntegration();
  
  // Teste 2: Responsividade
  const responsivenessResults = await testResponsiveness();
  
  // Relatório final
  console.log('\n📊 RELATÓRIO DE TESTES FRONTEND');
  console.log('='.repeat(50));
  
  console.log(`✅ Página carregada: ${integrationResults.pageLoaded ? 'SIM' : 'NÃO'}`);
  console.log(`🧩 Componente encontrado: ${integrationResults.telemetryComponentFound ? 'SIM' : 'NÃO'}`);
  console.log(`🔗 Hook funcionando: ${integrationResults.useRealtimeTelemetryWorking ? 'SIM' : 'NÃO'}`);
  console.log(`💾 Store funcionando: ${integrationResults.telemetryStoreWorking ? 'SIM' : 'NÃO'}`);
  console.log(`🔴 Indicador tempo real: ${integrationResults.realTimeIndicatorPresent ? 'SIM' : 'NÃO'}`);
  console.log(`🔄 Fallback polling: ${integrationResults.pollingFallbackWorking ? 'SIM' : 'NÃO'}`);
  console.log(`📊 Dados exibidos: ${integrationResults.dataDisplayedCorrectly ? 'SIM' : 'NÃO'}`);
  
  if (integrationResults.errors.length > 0) {
    console.log('\n❌ ERROS ENCONTRADOS:');
    integrationResults.errors.forEach((error, index) => {
      console.log(`${index + 1}. ${error}`);
    });
  }
  
  console.log('\n📱 RESPONSIVIDADE:');
  responsivenessResults.forEach(result => {
    console.log(`${result.responsive ? '✅' : '❌'} ${result.viewport}`);
  });
  
  // Avaliação geral
  const criticalTests = [
    integrationResults.pageLoaded,
    integrationResults.telemetryComponentFound,
    integrationResults.realTimeIndicatorPresent
  ];
  
  const allCriticalPassed = criticalTests.every(test => test);
  
  console.log('\n🎯 AVALIAÇÃO GERAL:');
  if (allCriticalPassed && integrationResults.errors.length === 0) {
    console.log('🟢 SUCESSO: Frontend integrado corretamente para telemetria em tempo real!');
  } else if (allCriticalPassed) {
    console.log('🟡 PARCIAL: Funcionalidade básica implementada, mas há melhorias necessárias');
  } else {
    console.log('🔴 FALHA: Frontend não está funcionando corretamente para telemetria em tempo real');
  }
  
  return { integrationResults, responsivenessResults };
}

// Executar se chamado diretamente
if (require.main === module) {
  runFrontendTests().catch(console.error);
}

module.exports = { runFrontendTests, testFrontendIntegration, testResponsiveness };