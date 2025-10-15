#!/usr/bin/env node

/**
 * 🔌 Simulador OCPP Configurável
 * 
 * Este script permite configurar e executar um simulador OCPP
 * com diferentes parâmetros através de prompts interativos.
 */

const WebSocket = require('ws');
const readline = require('readline');

class SimuladorOCPPConfiguravel {
  constructor(config) {
    this.chargeBoxId = config.chargeBoxId;
    this.wsUrl = config.wsUrl;
    this.ws = null;
    this.messageId = 1;
    this.transactionId = null;
    this.isCharging = false;
    this.meterValueInterval = null;
    this.config = config;
  }

  // Gerar ID único para mensagens
  getNextMessageId() {
    return (this.messageId++).toString();
  }

  // Conectar ao CSMS
  async connect() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Conectando simulador ${this.chargeBoxId} ao CSMS...`);
      console.log(`📡 URL: ${this.wsUrl}`);
      
      this.ws = new WebSocket(this.wsUrl, 'ocpp1.6');
      
      this.ws.on('open', () => {
        console.log('✅ Conectado ao CSMS!');
        this.setupMessageHandlers();
        resolve();
      });
      
      this.ws.on('error', (error) => {
        console.error('❌ Erro de conexão:', error.message);
        reject(error);
      });
    });
  }

  // Configurar handlers de mensagens
  setupMessageHandlers() {
    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error('❌ Erro ao processar mensagem:', error.message);
      }
    });
  }

  // Processar mensagens recebidas do CSMS
  handleMessage(message) {
    const [messageType, messageId, action, payload] = message;
    
    console.log(`📨 Recebido: ${action || 'Response'}`);
    console.log(`   Payload:`, payload || message[2]);
    
    // Se for um comando (Call = 2)
    if (messageType === 2) {
      this.handleCommand(messageId, action, payload);
    }
    // Se for uma resposta (CallResult = 3)
    else if (messageType === 3) {
      this.handleResponse(messageId, message[2]);
    }
  }

  // Processar comandos do CSMS
  handleCommand(messageId, action, payload) {
    switch (action) {
      case 'RemoteStartTransaction':
        this.handleRemoteStart(messageId, payload);
        break;
      case 'RemoteStopTransaction':
        this.handleRemoteStop(messageId, payload);
        break;
      case 'Reset':
        this.handleReset(messageId, payload);
        break;
      default:
        console.log(`⚠️  Comando não implementado: ${action}`);
        this.sendResponse(messageId, { status: 'Rejected' });
    }
  }

  // Processar respostas do CSMS
  handleResponse(messageId, payload) {
    if (payload && payload.status === 'Accepted') {
      console.log('✅ Comando aceito pelo CSMS');
    } else {
      console.log('❌ Comando rejeitado pelo CSMS:', payload);
    }
  }

  // Enviar resposta para o CSMS
  sendResponse(messageId, payload) {
    const response = [3, messageId, payload];
    this.ws.send(JSON.stringify(response));
  }

  // Enviar mensagem para o CSMS
  sendMessage(action, payload) {
    const messageId = this.getNextMessageId();
    const message = [2, messageId, action, payload];
    
    console.log(`📤 Enviando: ${action}`);
    this.ws.send(JSON.stringify(message));
    
    return messageId;
  }

  // Handler para RemoteStart
  handleRemoteStart(messageId, payload) {
    console.log('🚀 Recebido comando RemoteStart');
    
    if (!this.isCharging) {
      this.transactionId = Math.floor(Math.random() * 1000000000);
      this.isCharging = true;
      
      // Responder que aceita o comando
      this.sendResponse(messageId, { status: 'Accepted' });
      
      // Atualizar status para Charging
      setTimeout(() => {
        this.sendStatusNotification('Charging');
        this.startMeterValues();
      }, 1000);
    } else {
      this.sendResponse(messageId, { status: 'Rejected' });
    }
  }

  // Handler para RemoteStop
  handleRemoteStop(messageId, payload) {
    console.log('🛑 Recebido comando RemoteStop');
    
    if (this.isCharging) {
      this.isCharging = false;
      this.stopMeterValues();
      
      // Responder que aceita o comando
      this.sendResponse(messageId, { status: 'Accepted' });
      
      // Atualizar status para Available
      setTimeout(() => {
        this.sendStatusNotification('Available');
      }, 1000);
    } else {
      this.sendResponse(messageId, { status: 'Rejected' });
    }
  }

  // Handler para Reset
  handleReset(messageId, payload) {
    console.log('🔄 Recebido comando Reset');
    this.sendResponse(messageId, { status: 'Accepted' });
    
    setTimeout(() => {
      console.log('🔄 Reiniciando simulador...');
      process.exit(0);
    }, 2000);
  }

  // Enviar BootNotification
  async sendBootNotification() {
    const payload = {
      chargePointVendor: this.config.vendor || 'SimuladorOCPP',
      chargePointModel: this.config.model || 'Teste-v1.0',
      chargePointSerialNumber: this.chargeBoxId,
      firmwareVersion: this.config.firmware || '1.0.0'
    };
    
    this.sendMessage('BootNotification', payload);
  }

  // Enviar StatusNotification
  sendStatusNotification(status) {
    const payload = {
      connectorId: 1,
      errorCode: 'NoError',
      status: status,
      timestamp: new Date().toISOString()
    };
    
    console.log(`📊 Status atualizado: ${status}`);
    this.sendMessage('StatusNotification', payload);
  }

  // Iniciar envio de MeterValues
  startMeterValues() {
    if (this.meterValueInterval) return;
    
    this.meterValueInterval = setInterval(() => {
      const power = Math.floor(Math.random() * 10000) + 1000; // 1-11kW
      const voltage = 220 + Math.random() * 20; // 220-240V
      const current = power / voltage;
      
      console.log(`📊 Telemetria: ${power}W, ${voltage.toFixed(1)}V, ${current.toFixed(1)}A`);
      
      const payload = {
        connectorId: 1,
        transactionId: this.transactionId,
        meterValue: [{
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: power.toString(), measurand: 'Power.Active.Import', unit: 'W' },
            { value: voltage.toFixed(1), measurand: 'Voltage', unit: 'V' },
            { value: current.toFixed(1), measurand: 'Current.Import', unit: 'A' }
          ]
        }]
      };
      
      this.sendMessage('MeterValues', payload);
    }, this.config.telemetryInterval || 5000);
  }

  // Parar envio de MeterValues
  stopMeterValues() {
    if (this.meterValueInterval) {
      clearInterval(this.meterValueInterval);
      this.meterValueInterval = null;
    }
  }

  // Iniciar simulação
  async start() {
    try {
      await this.connect();
      await this.sendBootNotification();
      
      // Status inicial
      setTimeout(() => {
        this.sendStatusNotification('Available');
      }, 2000);
      
      console.log('\n✅ Simulador iniciado com sucesso!');
      console.log('💡 Use a API para enviar comandos ou aguarde comandos automáticos...');
      
    } catch (error) {
      console.error('❌ Erro ao iniciar simulador:', error.message);
      process.exit(1);
    }
  }
}

// Função para coletar configurações via prompt
async function coletarConfiguracoes() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const pergunta = (texto) => {
    return new Promise((resolve) => {
      rl.question(texto, resolve);
    });
  };

  console.log('🔧 Configuração do Simulador OCPP\n');

  const config = {};

  // Configurações básicas
  config.chargeBoxId = await pergunta('📋 ID do Charge Point (ex: TESTE-001): ') || 'TESTE-001';
  
  const host = await pergunta('🌐 Host do CSMS (padrão: localhost): ') || 'localhost';
  const porta = await pergunta('🔌 Porta do CSMS (padrão: 3000): ') || '3000';
  config.wsUrl = `ws://${host}:${porta}/ocpp/CentralSystemService/${config.chargeBoxId}`;
  
  // Configurações opcionais
  config.vendor = await pergunta('🏭 Fabricante (padrão: SimuladorOCPP): ') || 'SimuladorOCPP';
  config.model = await pergunta('📱 Modelo (padrão: Teste-v1.0): ') || 'Teste-v1.0';
  config.firmware = await pergunta('💾 Versão Firmware (padrão: 1.0.0): ') || '1.0.0';
  
  const intervalo = await pergunta('⏱️  Intervalo telemetria em ms (padrão: 5000): ') || '5000';
  config.telemetryInterval = parseInt(intervalo);

  rl.close();

  console.log('\n📋 Configuração coletada:');
  console.log('─'.repeat(50));
  console.log(`Charge Point ID: ${config.chargeBoxId}`);
  console.log(`URL WebSocket: ${config.wsUrl}`);
  console.log(`Fabricante: ${config.vendor}`);
  console.log(`Modelo: ${config.model}`);
  console.log(`Firmware: ${config.firmware}`);
  console.log(`Intervalo Telemetria: ${config.telemetryInterval}ms`);
  console.log('─'.repeat(50));

  return config;
}

// Função principal
async function main() {
  try {
    // Se argumentos foram passados via linha de comando, usar modo rápido
    if (process.argv.length > 2) {
      const chargeBoxId = process.argv[2];
      const host = process.argv[3] || 'localhost';
      const porta = process.argv[4] || '3000';
      
      const config = {
        chargeBoxId,
        wsUrl: `ws://${host}:${porta}/ocpp/CentralSystemService/${chargeBoxId}`,
        vendor: 'SimuladorOCPP',
        model: 'Teste-v1.0',
        firmware: '1.0.0',
        telemetryInterval: 5000
      };
      
      console.log(`🚀 Modo rápido: Iniciando simulador ${chargeBoxId}`);
      const simulador = new SimuladorOCPPConfiguravel(config);
      await simulador.start();
    } else {
      // Modo interativo
      const config = await coletarConfiguracoes();
      const simulador = new SimuladorOCPPConfiguravel(config);
      await simulador.start();
    }
  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  main();
}

module.exports = SimuladorOCPPConfiguravel;