const { WebSocket } = require('ws');

const BASE_HTTP = process.env.BASE_HTTP || 'http://localhost:3000';
const BASE_WS   = process.env.BASE_WS   || 'ws://localhost:3000';
const API_KEY   = process.env.API_KEY   || 'minha_chave_super_secreta';
const CBID      = process.env.CHARGE_BOX_ID || 'DRBAKANA-TEST-03';
const ID_TAG    = process.env.ID_TAG || 'DEMO-123456';
const CONNECTOR = Number(process.env.CONNECTOR_ID || '1');

const PATH = `/ocpp/CentralSystemService/${encodeURIComponent(CBID)}`;

function uid() {
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

async function httpJson(path) {
  const url = `${BASE_HTTP}${path}`;
  const res = await fetch(url, { headers: { 'X-API-Key': API_KEY } });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt, status: res.status }; }
}

function sendCall(ws, action, payload) {
  const id = uid();
  const frame = [2, id, action, payload];
  ws.send(JSON.stringify(frame));
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (Array.isArray(m) && m[0] === 3 && m[1] === id) {
          ws.off('message', onMsg);
          resolve(m[2]);
        } else if (Array.isArray(m) && m[0] === 4 && m[1] === id) {
          ws.off('message', onMsg);
          reject(new Error(`${m[2]}: ${m[3]}`));
        }
      } catch {}
    };
    ws.on('message', onMsg);
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout')); }, 15000);
  });
}

(async () => {
  console.log('== Conectando ao CSMS ==');
  const ws = new WebSocket(`${BASE_WS}${PATH}`, 'ocpp1.6');

  ws.on('open', async () => {
    try {
      console.log('WS aberto, enviando BootNotification');
      await sendCall(ws, 'BootNotification', { chargePointVendor: 'Test', chargePointModel: 'WS-Tester' });
    } catch (e) { console.warn('BootNotification falhou (segue):', e.message); }

    try {
      console.log('Enviando Authorize');
      await sendCall(ws, 'Authorize', { idTag: ID_TAG });
    } catch (e) { console.warn('Authorize falhou (segue):', e.message); }

    console.log('Enviando StartTransaction');
    const st = await sendCall(ws, 'StartTransaction', {
      connectorId: CONNECTOR,
      idTag: ID_TAG,
      timestamp: new Date().toISOString(),
      meterStart: 1000
    });
    const tx = Number(st?.transactionId ?? st?.transaction_id);
    console.log('StartTransaction.conf => transactionId=', tx);

    console.log('Enviando MeterValues');
    await sendCall(ws, 'MeterValues', {
      transactionId: tx,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: '1500', measurand: 'Energy.Active.Import.Register' },
          { value: '3100', measurand: 'Power.Active.Import' }
        ]
      }]
    });

    console.log('Consultando sessão ativa/detail...');
    const detail = await httpJson(`/v1/sessions/active/${encodeURIComponent(CBID)}/detail`);
    console.log('detail=', detail);

    console.log('Consultando eventos StartTransaction...');
    const ev = await httpJson(`/v1/events?event_type=StartTransaction&charge_box_id=${encodeURIComponent(CBID)}&limit=5&sort=desc`);
    console.log('events=', ev);

    console.log('Consultando telemetria por tx...');
    const tel = await httpJson(`/v1/sessions/${tx}/telemetry`);
    console.log('telemetry=', tel);

    try { ws.close(1000, 'done'); } catch {}
    process.exit(0);
  });

  ws.on('error', (e) => {
    console.error('WS error:', e.message);
    process.exit(1);
  });
})();