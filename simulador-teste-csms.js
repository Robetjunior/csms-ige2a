#!/usr/bin/env node

/**
 * 🎯 Simulador de Teste CSMS - Demonstração Completa
 * 
 * Este simulador conecta ao CSMS e responde aos comandos enviados pelo dashboard.
 * Demonstra a integração completa: Dashboard → CSMS → Simulador
 */

const WebSocket = require('ws');

class CSMSTestSimulator {
  constructor(chargeBoxId = 'test-charger') {
    this.chargeBoxId = chargeBoxId;
    this.ws = null;
    this.isConnected = false;
    this.currentStatus = 'Available';
    this.transactionId = null;
    this.connectorId = 1;
    
    // Configurações de telemetria
    this.telemetry = {
      power: 0,
      voltage: 230,
      current: 0,
      temperature: 25,
      energy: 0,
      soc: 50
    };
    
    this.heartbeatInterval = null;
    this.telemetryInterval = null;
  }

  connect() {
    console.log(`🔌 Conectando simulador ${this.chargeBoxId} ao CSMS...`);
    
    const wsUrl = `ws://localhost:3000/ocpp/CentralSystemService/${this.chargeBoxId}`;
    this.ws = new WebSocket(wsUrl, ['ocpp1.6']);

    this.ws.on('open', () => {
      console.log(`✅ Conectado ao CSMS como ${this.chargeBoxId}`);
      this.isConnected = true;
      this.sendBootNotification();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error('❌ Erro ao processar mensagem:', error);
      }
    });

    this.ws.on('close', () => {
      console.log('🔌 Conexão fechada');
      this.isConnected = false;
      this.stopIntervals();
    });

    this.ws.on('error', (error) => {
      console.error('❌ Erro na conexão WebSocket:', error.message);
    });
  }

  handleMessage(message) {
    console.log('📨 Mensagem bruta recebida:', message);
    
    if (!Array.isArray(message) || message.length < 3) {
      console.log('⚠️ Formato de mensagem inválido');
      return;
    }
    
    const [messageType, messageId, actionOrPayload, payload] = message;
    
    // Tipo 2 = Call (comando do CSMS para o CP)
    if (messageType === 2) {
      const action = actionOrPayload;
      console.log(`📨 Comando recebido: ${action}`, payload);
      
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
        case 'GetConfiguration':
          this.handleGetConfiguration(messageId, payload);
          break;
        case 'GetDiagnostics':
          this.handleGetDiagnostics(messageId, payload);
          break;
        default:
          console.log(`⚠️ Ação não implementada: ${action}`);
          this.sendCallResult(messageId, {});
      }
    }
    // Tipo 3 = CallResult (resposta do CSMS para o CP)
    else if (messageType === 3) {
      const result = actionOrPayload;
      console.log(`✅ Resposta recebida para ${messageId}:`, result);
    }
    // Tipo 4 = CallError
    else if (messageType === 4) {
      const [errorCode, errorDescription, errorDetails] = [actionOrPayload, payload, message[4]];
      console.log(`❌ Erro recebido para ${messageId}: ${errorCode} - ${errorDescription}`);
    }
    else {
      console.log(`⚠️ Tipo de mensagem desconhecido: ${messageType}`);
    }
  }

  handleRemoteStart(messageId, payload) {
    console.log(`🚀 Iniciando carregamento remoto...`);
    
    // Simular preparação
    this.updateStatus('Preparing');
    
    setTimeout(() => {
      // Gerar ID de transação
      this.transactionId = Math.floor(Math.random() * 100000);
      
      // Enviar resposta de sucesso
      this.sendCallResult(messageId, { status: 'Accepted' });
      
      // Iniciar transação
      this.sendStartTransaction(payload.idTag);
      
      // Atualizar status para carregando
      this.updateStatus('Charging');
      
      // Iniciar telemetria de carregamento
      this.startChargingTelemetry();
      
    }, 2000);
  }

  handleRemoteStop(messageId, payload) {
    console.log(`🛑 Parando carregamento remoto...`);
    
    // Atualizar status para finalizando
    this.updateStatus('Finishing');
    
    setTimeout(() => {
      // Enviar resposta de sucesso
      this.sendCallResult(messageId, { status: 'Accepted' });
      
      // Parar carregamento
      this.sendStopTransaction();
      
      // Atualizar status para disponível
      this.updateStatus('Available');
      
      // Parar telemetria de carregamento
      this.stopChargingTelemetry();
      
    }, 2000);
  }

  handleReset(messageId, payload) {
    console.log(`🔄 Executando reset ${payload.type}...`);
    
    // Enviar resposta de sucesso
    this.sendCallResult(messageId, { status: 'Accepted' });
    
    setTimeout(() => {
      console.log('🔄 Simulando reinicialização...');
      this.disconnect();
      
      setTimeout(() => {
        this.connect();
      }, 3000);
    }, 1000);
  }

  handleGetConfiguration(messageId, payload) {
    console.log(`⚙️ Obtendo configuração...`);
    
    const configuration = {
      configurationKey: [
        { key: 'HeartbeatInterval', readonly: false, value: '300' },
        { key: 'MeterValueSampleInterval', readonly: false, value: '60' },
        { key: 'ClockAlignedDataInterval', readonly: false, value: '900' },
        { key: 'ConnectionTimeOut', readonly: false, value: '60' }
      ],
      unknownKey: []
    };
    
    this.sendCallResult(messageId, configuration);
  }

  handleGetDiagnostics(messageId, payload) {
    console.log(`📊 Obtendo diagnósticos...`);
    
    const diagnostics = {
      fileName: `diagnostics_${this.chargeBoxId}_${new Date().toISOString().split('T')[0]}.log`
    };
    
    this.sendCallResult(messageId, diagnostics);
  }

  sendBootNotification() {
    const bootNotification = [
      2,
      this.generateMessageId(),
      'BootNotification',
      {
        chargePointVendor: 'IGE2A',
        chargePointModel: 'Simulador-v1.0',
        chargePointSerialNumber: `SIM-${this.chargeBoxId}`,
        firmwareVersion: '1.0.0'
      }
    ];
    
    this.sendMessage(bootNotification);
  }

  sendStartTransaction(idTag) {
    const startTransaction = [
      2,
      this.generateMessageId(),
      'StartTransaction',
      {
        connectorId: this.connectorId,
        idTag: idTag,
        meterStart: 0,
        timestamp: new Date().toISOString()
      }
    ];
    
    this.sendMessage(startTransaction);
  }

  sendStopTransaction() {
    const stopTransaction = [
      2,
      this.generateMessageId(),
      'StopTransaction',
      {
        transactionId: this.transactionId,
        meterStop: Math.floor(this.telemetry.energy),
        timestamp: new Date().toISOString()
      }
    ];
    
    this.sendMessage(stopTransaction);
    this.transactionId = null;
  }

  updateStatus(status) {
    this.currentStatus = status;
    
    const statusNotification = [
      2,
      this.generateMessageId(),
      'StatusNotification',
      {
        connectorId: this.connectorId,
        status: status,
        errorCode: 'NoError',
        timestamp: new Date().toISOString()
      }
    ];
    
    this.sendMessage(statusNotification);
    console.log(`📊 Status atualizado para: ${status}`);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        const heartbeat = [
          2,
          this.generateMessageId(),
          'Heartbeat',
          {}
        ];
        this.sendMessage(heartbeat);
      }
    }, 30000); // 30 segundos
  }

  startChargingTelemetry() {
    let powerLevel = 0;
    
    this.telemetryInterval = setInterval(() => {
      if (this.currentStatus === 'Charging') {
        // Simular ramp-up de potência
        if (powerLevel < 50000) {
          powerLevel += 2000; // 2kW por segundo
        }
        
        // Atualizar telemetria
        this.telemetry.power = powerLevel;
        this.telemetry.current = powerLevel / this.telemetry.voltage;
        this.telemetry.energy += (powerLevel / 3600000); // Wh para kWh
        this.telemetry.temperature = 25 + (powerLevel / 2000); // Aquecimento
        this.telemetry.soc = Math.min(80, 50 + (this.telemetry.energy * 10));
        
        // Enviar valores de medição
        this.sendMeterValues();
      }
    }, 1000);
  }

  stopChargingTelemetry() {
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
    
    // Reset telemetria
    this.telemetry.power = 0;
    this.telemetry.current = 0;
    this.telemetry.temperature = 25;
  }

  sendMeterValues() {
    const meterValues = [
      2,
      this.generateMessageId(),
      'MeterValues',
      {
        connectorId: this.connectorId,
        transactionId: this.transactionId,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              { value: this.telemetry.power.toString(), measurand: 'Power.Active.Import', unit: 'W' },
              { value: this.telemetry.voltage.toString(), measurand: 'Voltage', unit: 'V' },
              { value: this.telemetry.current.toFixed(1), measurand: 'Current.Import', unit: 'A' },
              { value: this.telemetry.temperature.toFixed(1), measurand: 'Temperature', unit: 'Celsius' },
              { value: this.telemetry.energy.toFixed(3), measurand: 'Energy.Active.Import.Register', unit: 'kWh' },
              { value: this.telemetry.soc.toFixed(1), measurand: 'SoC', unit: 'Percent' }
            ]
          }
        ]
      }
    ];
    
    this.sendMessage(meterValues);
  }

  sendCallResult(messageId, payload) {
    const callResult = [3, messageId, payload];
    this.sendMessage(callResult);
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  generateMessageId() {
    return Math.random().toString(36).substr(2, 9);
  }

  stopIntervals() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
  }

  disconnect() {
    this.stopIntervals();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Inicializar simulador
console.log('🎯 Iniciando Simulador de Teste CSMS...');
console.log('📋 Funcionalidades:');
console.log('   ✅ Conexão WebSocket OCPP 1.6');
console.log('   ✅ Resposta a comandos RemoteStart/RemoteStop');
console.log('   ✅ Comandos de diagnóstico (Reset, GetConfiguration, GetDiagnostics)');
console.log('   ✅ Telemetria em tempo real durante carregamento');
console.log('   ✅ Simulação de estados de carregamento');
console.log('');

const simulator = new CSMSTestSimulator('test-charger');
simulator.connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando simulador...');
  simulator.disconnect();
  process.exit(0);
});

console.log('💡 Dica: Acesse http://localhost:5173 para controlar o simulador via dashboard!');
console.log('🎮 Use os botões no painel de controle CSMS para enviar comandos.');