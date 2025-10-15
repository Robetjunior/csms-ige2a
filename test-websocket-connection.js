#!/usr/bin/env node

/**
 * 🔌 Teste de Conectividade WebSocket OCPP
 * 
 * Script simples para testar a conexão WebSocket com o CSMS
 */

const WebSocket = require('ws');

const CHARGE_BOX_ID = 'DRBAKANA-TEST-55';
const CSMS_URL = `ws://localhost:3000/ocpp/CentralSystemService/${CHARGE_BOX_ID}`;

console.log('🔌 Teste de Conectividade WebSocket OCPP');
console.log('─'.repeat(50));
console.log(`📋 Charge Box ID: ${CHARGE_BOX_ID}`);
console.log(`📡 URL: ${CSMS_URL}`);
console.log(`🔗 Protocolo: ocpp1.6`);
console.log('─'.repeat(50));

console.log('\n🔄 Tentando conectar...');

const ws = new WebSocket(CSMS_URL, 'ocpp1.6');

ws.on('open', () => {
  console.log('✅ Conectado ao CSMS com sucesso!');
  
  // Enviar BootNotification
  const bootNotification = [
    2, // Call
    "1", // Message ID
    "BootNotification",
    {
      chargePointVendor: "TestSimulator",
      chargePointModel: "DRBAKANA-Model",
      chargePointSerialNumber: "DRBAKANA-TEST-55",
      firmwareVersion: "1.0.0"
    }
  ];
  
  console.log('📤 Enviando BootNotification...');
  ws.send(JSON.stringify(bootNotification));
});

ws.on('message', (data) => {
  console.log('📨 Mensagem recebida:', data.toString());
  
  // Fechar conexão após receber resposta
  setTimeout(() => {
    console.log('🔚 Fechando conexão...');
    ws.close();
  }, 2000);
});

ws.on('error', (error) => {
  console.error('❌ Erro de conexão:', error.message);
  console.error('🔍 Detalhes do erro:', error);
  
  // Sugestões de troubleshooting
  console.log('\n🛠️ Possíveis soluções:');
  console.log('1. Verifique se o CSMS está rodando na porta 3000');
  console.log('2. Execute: docker compose ps');
  console.log('3. Verifique os logs: docker compose logs orchestrator');
  console.log('4. Teste conectividade: curl http://localhost:3000/health');
});

ws.on('close', (code, reason) => {
  console.log(`🔚 Conexão fechada - Código: ${code}, Motivo: ${reason || 'N/A'}`);
  
  if (code === 1006) {
    console.log('\n⚠️ Código 1006 indica fechamento anormal da conexão');
    console.log('🔍 Possíveis causas:');
    console.log('- Servidor não está rodando');
    console.log('- Firewall bloqueando a conexão');
    console.log('- Endpoint incorreto');
    console.log('- Problema de rede');
  }
  
  process.exit(code === 1000 ? 0 : 1);
});

// Timeout de segurança
setTimeout(() => {
  console.log('⏰ Timeout - Conexão não estabelecida em 10 segundos');
  ws.close();
  process.exit(1);
}, 10000);