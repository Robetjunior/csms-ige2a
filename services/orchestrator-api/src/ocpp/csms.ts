import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

import {
  OCPP_SUBPROTOCOL,
  OCPP_ACCEPTED_SUBPROTOCOLS,
  OCPP_PATH_PREFIX,
  OCPP_PING_MS,
  OCPP_CALL_TIMEOUT_MS,
  isCall, isResult, isError, type OcppFrame
} from './types';
import { ConnectionRegistry } from './registry';

import {
  insertEvento,
  upsertSessionStart,
  stopSession,
  completeRemoteStopForTx
} from '../services/repo';
import { publish } from '../routes/stream';
import { telemetryManager } from '../services/telemetry-manager';
import { pg } from '../db';

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout };

export class OcppCsms extends EventEmitter {
  private registry = new ConnectionRegistry();
  private wss?: WebSocketServer;
  private pending = new Map<string, Pending>(); // uid -> pending call

  // ---- Pass-throughs p/ debug router ----
  resolveTx(tx: number) { return this.registry.resolveTx(tx); }
  listTxBindings() { return this.registry.listTxBindings(); }
  getLastTxForChargeBox(cbid: string) { return this.registry.getLastTxForChargeBox(cbid); }
  getConnectorStatuses(cbid: string) { return this.registry.getConnectorStatuses(cbid); }
  getLastHeartbeat(cbid: string) { return this.registry.getLastHeartbeat(cbid); }
  listOnline(): string[] { return this.registry.listPeers(); }
  getStatusSnapshot(cbid: string) { return this.registry.getStatusSnapshot(cbid); }
  getHeartbeatInterval(cbid: string) { return this.registry.getHeartbeatInterval(cbid); }

  /** Sobe o servidor OCPP sobre o mesmo HTTP server do Express */
  start(server: http.Server) {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => {
        // Accept either ocpp1.6 or ocpp1.6j; prefer what the client requested
        const requested = Array.from(protocols);
        const match = requested.find(p => OCPP_ACCEPTED_SUBPROTOCOLS.includes(p as any));
        const accepted = match || (protocols.has(OCPP_SUBPROTOCOL) ? OCPP_SUBPROTOCOL : false);
        console.log(`[OCPP DEBUG] handleProtocols requested=${requested.join(', ') || '(none)'} accepted=${accepted || '(none)'}`);
        return accepted;
      },
    });

    server.on('upgrade', (req, socket, head) => {
      console.log(`[OCPP DEBUG] Upgrade request: ${req.url}`);
      console.log(`[OCPP DEBUG] Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol'] ?? '(none)'}`);
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      console.log(`[OCPP DEBUG] Parsed URL pathname: ${url.pathname}`);
      console.log(`[OCPP DEBUG] Expected prefix: ${OCPP_PATH_PREFIX}/`);
      if (!url.pathname.startsWith(`${OCPP_PATH_PREFIX}/`)) {
        console.log(`[OCPP DEBUG] Path doesn't match, rejecting upgrade and destroying socket`);
        try { socket.destroy(); } catch {}
        return;
      }
      console.log(`[OCPP DEBUG] Path matches, handling upgrade`);
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        console.log(`[OCPP DEBUG] WebSocket upgraded, emitting connection`);
        this.wss!.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      console.log(`[OCPP DEBUG] Connection event received (protocol=${ws.protocol || '(none)'})`);
      this.handleConnection(ws, req);
    });

    console.log(`[OCPP] ready at ws://<host>:<port>${OCPP_PATH_PREFIX}/<CPID> (${OCPP_SUBPROTOCOL})`);
  }

  /* ============ PUBLIC API (comandos CSMS -> CP) ============ */

  async remoteStart(chargeBoxId: string, args: { idTag: string; connectorId?: number }) {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    try { console.log(`[OCPP-CSMS] RemoteStart.sending chargeBoxId=${chargeBoxId} idTag=${args.idTag} connectorId=${args.connectorId ?? '(none)'}`); } catch {}
    return this.sendCall(ws, 'RemoteStartTransaction', {
      idTag: args.idTag,
      ...(args.connectorId ? { connectorId: args.connectorId } : {}),
    });
  }

  async remoteStop(transactionId: number, chargeBoxId?: string) {
    const cbid = chargeBoxId || this.registry.resolveTx(transactionId);
    if (!cbid) throw new Error('unknown_transaction');
    const ws = this.registry.getPeer(cbid);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    return this.sendCall(ws, 'RemoteStopTransaction', { transactionId });
  }

  async changeAvailability(chargeBoxId: string, arg: { connectorId: number; type: 'Operative'|'Inoperative' }) {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    return this.sendCall(ws, 'ChangeAvailability', {
      connectorId: arg.connectorId,
      type: arg.type,
    });
  }

  async reserveNow(chargeBoxId: string, arg: { idTag: string; connectorId: number; reservationId: number; expiryDate: string }) {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    return this.sendCall(ws, 'ReserveNow', {
      connectorId: arg.connectorId,
      expiryDate: arg.expiryDate,
      idTag: arg.idTag,
      reservationId: arg.reservationId,
    });
  }

  async cancelReservation(chargeBoxId: string, reservationId: number) {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    return this.sendCall(ws, 'CancelReservation', { reservationId });
  }

  /** Reset (OCPP 1.6) */
  async reset(chargeBoxId: string, type: 'Soft'|'Hard' = 'Soft') {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    return this.sendCall(ws, 'Reset', { type });
  }

  /** Força desconexão do socket (útil para “desbugar”) */
  async kick(chargeBoxId: string) {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws) return { ok: false, reason: 'not_connected' as const };
    try {
      ws.close(4000, 'kicked_by_csms');
      this.registry.delPeer(chargeBoxId);
      return { ok: true as const, disconnected: true };
    } catch (e: any) {
      return { ok: false as const, reason: e?.message || String(e) };
    }
  }

  /* ======================= Internals ======================== */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage) {
    console.log(`[OCPP DEBUG] handleConnection called with URL: ${req.url}`);
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    console.log(`[OCPP DEBUG] URL pathname: ${url.pathname}`);
    const chargeBoxId = decodeURIComponent(url.pathname.split('/').pop() || 'unknown').trim();
    console.log(`[OCPP DEBUG] Extracted chargeBoxId: ${chargeBoxId}`);

    this.registry.setPeer(chargeBoxId, ws);
    console.log(`[OCPP DEBUG] Registry setPeer called for: ${chargeBoxId}`);
    console.log(`[OCPP] CP connected: ${chargeBoxId}`);

    const iv = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, OCPP_PING_MS);
    ws.on('close', () => {
      clearInterval(iv);
      this.registry.delPeer(chargeBoxId);
      console.log(`[OCPP] CP disconnected: ${chargeBoxId}`);
      try {
        const current = this.registry.getConnectorStatuses(chargeBoxId);
        const now = new Date().toISOString();
        for (const c of current) {
          this.registry.setConnectorStatus(chargeBoxId, c.connectorId, 'Unknown', c.errorCode, now);
          try { publish({ type: 'status.changed', chargeBoxId, connectorId: c.connectorId, status: 'Unknown', updatedAt: now }); } catch {}
        }
      } catch {}
      try { pg.query(`UPDATE orchestrator.commands SET status='failed', updated_at=now() WHERE charge_box_id=$1 AND command_type='RemoteStart' AND status IN ('pending','sent')`, [chargeBoxId]); } catch {}
    });

    ws.on('message', async (raw: Buffer) => {
      let m: OcppFrame;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (isCall(m)) {
        const [, uid, action, payload] = m;
        try { console.log(`[OCPP-CSMS] Frame.received direction=in action=${action} uniqueId=${uid}`); } catch {}
        if (action === 'StartTransaction') { try { console.log(`[OCPP-CSMS] StartTransaction.req chargeBoxId=${chargeBoxId} payload=${JSON.stringify(payload)}`); } catch {} }
        if (action === 'Authorize') { try { console.log(`[OCPP-CSMS] Authorize.req payload=${JSON.stringify(payload)}`); } catch {} }
        try {
          await this.handleCall(ws, chargeBoxId, uid, action, payload);
        } catch (e:any) {
          console.error('[OCPP] handleCall top-level error:', e?.message || e);
        }
        return;
      }

      if (isResult(m)) {
        const [, uid, payload] = m;
        const p = this.pending.get(uid);
        if (p) { clearTimeout(p.timer); p.resolve(payload); this.pending.delete(uid); }
        try { console.log(`[OCPP-CSMS] Frame.received direction=in action=CALLRESULT uniqueId=${uid}`); } catch {}
        return;
      }

      if (isError(m)) {
        const [, uid, code, desc, details] = m;
        const p = this.pending.get(uid);
        if (p) { clearTimeout(p.timer); p.reject(new Error(`${code}: ${desc}`)); this.pending.delete(uid); }
        console.warn('[OCPP] CALLERROR', { uid, code, desc, details });
        try { console.log(`[OCPP-CSMS] Frame.received direction=in action=CALLERROR uniqueId=${uid} code=${code} desc=${desc}`); } catch {}
      }
    });
  }

  private emitStatusChanged(chargeBoxId: string, connectorId: number, status: string, whenISO?: string) {
    const at = whenISO ?? new Date().toISOString();
    try {
      this.registry.setConnectorStatus(chargeBoxId, connectorId, status, '', at);
    } catch {}
    try {
      publish({ type: 'status.changed', chargeBoxId, connectorId, status, updatedAt: at });
    } catch (e:any) {
      console.warn('[OCPP] publish status.changed falhou:', e?.message || e);
    }

    if (String(status).toLowerCase() === 'available') {
      (async () => {
        try {
          const r = await pg.query<{ transaction_id: number }>(
            `SELECT transaction_id
               FROM orchestrator.sessions
              WHERE charge_box_id = $1 AND stopped_at IS NULL
              ORDER BY id DESC
              LIMIT 1`,
            [chargeBoxId]
          );
          if (r.rowCount > 0) {
            const tx = Number(r.rows[0].transaction_id);
            try {
              await stopSession({ transactionId: tx, stoppedAt: new Date(at), stopReason: 'StatusAvailableCleanup' });
            } catch (e:any) {
              console.warn('[OCPP] stopSession@AvailableCleanup falhou:', e?.message || e);
            }
          }
        } catch (e:any) {
          console.warn('[OCPP] query active session on Available falhou:', e?.message || e);
        }
      })();
    }
  }

  private async handleCall(ws: WebSocket, chargeBoxId: string, uid: string, action: string, p: any) {
    const ok  = (payload: any) => this.sendResult(ws, uid, payload);
    const ack = () => this.sendResult(ws, uid, {});

    try {
      switch (action) {
        case 'BootNotification': {
          ok({ status: 'Accepted', currentTime: new Date().toISOString(), interval: 180 });
          try { this.registry.setHeartbeatInterval(chargeBoxId, 180); } catch {}
          try { this.registry.setHeartbeat(chargeBoxId); } catch {}

          // (opcional) provisionamento leve do charge box no banco poderia entrar aqui

          // persiste evento
          try {
            await insertEvento({
              tipo: 'BootNotification',
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: null
            });
          } catch (e:any) {
            console.warn('[OCPP] insertEvento BootNotification falhou:', e?.message || e);
          }
          return;
        }

        case 'Authorize': {
          ok({ idTagInfo: { status: 'Accepted' } });
          try {
            await insertEvento({
              tipo: 'Authorize',
              payload: p,
              chargeBoxId,
              idTag: p?.idTag ?? null,
              transactionId: null
            });
          } catch (e:any) {
            console.warn('[OCPP] insertEvento Authorize falhou:', e?.message || e);
          }
          return;
        }

        case 'StartTransaction': {
          const result = await this.handleStartTransaction(chargeBoxId, p);
          ok(result);
          return;
        }

        case 'MeterValues': {
          ack();

          const tx = Number(p?.transactionId);
          if (Number.isFinite(tx) && tx > 0) this.registry.bindTx(tx, chargeBoxId);
          try { console.log(`[OCPP-CSMS] MeterValues.received chargeBoxId=${chargeBoxId} transaction_id=${Number.isFinite(tx)?tx:'(none)'} payload=${JSON.stringify(p)}`); } catch {}

          try {
            await insertEvento({ tipo: 'MeterValues', payload: p, chargeBoxId, idTag: null, transactionId: Number.isFinite(tx) && tx > 0 ? tx : null });
          } catch (e:any) { console.warn('[OCPP] insertEvento MeterValues falhou:', e?.message || e); }

          try { await telemetryManager.processMeterValues(chargeBoxId, Number.isFinite(tx) ? tx : 0, p); } catch (e:any) { console.warn('[OCPP] telemetryManager.processMeterValues falhou:', e?.message || e); }
          return;
        }

        // OCPP 2.0.1 — TransactionEvent (Started/Updated/Ended)
        case 'TransactionEvent': {
          // Acknowledge imediatamente
          ack();

          try {
            await insertEvento({
              tipo: 'TransactionEvent',
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: Number(p?.transactionInfo?.transactionId ?? 0) || null,
            });
          } catch (e:any) {
            console.warn('[OCPP] insertEvento TransactionEvent falhou:', e?.message || e);
          }

          // Eventos de sessão
          try {
            const evType = String(p?.eventType || '').toLowerCase();
            const txIdNum = Number(p?.transactionInfo?.transactionId ?? 0);
            const startedAt = p?.timestamp ? new Date(p.timestamp) : new Date();
            const connectorId = Number(p?.evse?.connectorId || 1);

            if (evType === 'started' && Number.isFinite(txIdNum) && txIdNum > 0) {
              // Registra sessão e telemetry
              await upsertSessionStart({ transactionId: txIdNum, chargeBoxId, idTag: p?.transactionInfo?.idToken?.idToken ?? null, startedAt });
              telemetryManager.startSession({
                transactionId: txIdNum,
                chargeBoxId,
                startedAt,
                meterStartWh: Number(p?.transactionInfo?.totalEnergyConsumed ?? 0),
                idTag: p?.transactionInfo?.idToken?.idToken ?? null,
              });
              this.emitStatusChanged(chargeBoxId, connectorId, 'Charging', startedAt.toISOString());
            }

            if (evType === 'updated') {
              // Telemetria em tempo real
              try { await telemetryManager.processTransactionEvent(chargeBoxId, p); } catch (e:any) {
                console.warn('[OCPP] telemetryManager.processTransactionEvent falhou:', e?.message || e);
              }
            }

            if (evType === 'ended' && Number.isFinite(txIdNum) && txIdNum > 0) {
              const stoppedAt = p?.timestamp ? new Date(p.timestamp) : new Date();
              try {
                await stopSession({ transactionId: txIdNum, stoppedAt, stopReason: p?.triggerReason ?? 'Local' });
                telemetryManager.stopSession(txIdNum);
              } catch (e:any) { console.warn('[OCPP] stopSession@TransactionEvent falhou:', e?.message || e); }

              try { publish({ type: 'session.stopped', chargeBoxId, transactionId: txIdNum, stoppedAt: stoppedAt.toISOString(), reason: String(p?.triggerReason || 'Local') }); } catch {}
              this.emitStatusChanged(chargeBoxId, connectorId, 'Available', stoppedAt.toISOString());
            }
          } catch (e:any) {
            console.warn('[OCPP] handle TransactionEvent falhou:', e?.message || e);
          }
          return;
        }

        case 'StopTransaction': {
          const tx = Number(p?.transactionId);
          const stoppedAt = p?.timestamp ? new Date(p.timestamp) : new Date();

          ack();

          try {
            await stopSession({ transactionId: tx, stoppedAt, stopReason: p?.reason ?? 'Local' });
            
            // Remove sessão do telemetry manager
            telemetryManager.stopSession(tx);
          } catch (e:any) { console.warn('[OCPP] stopSession falhou:', e?.message || e); }

          try {
            await insertEvento({ tipo: 'StopTransaction', payload: p, chargeBoxId, idTag: null, transactionId: tx });
          } catch (e:any) { console.warn('[OCPP] insertEvento StopTransaction falhou:', e?.message || e); }

          try {
            const r = await completeRemoteStopForTx({ transactionId: tx, response: p });
            if (!r || (r as any).updated === false) {
              console.warn('[OCPP] completeRemoteStopForTx: nenhum comando atualizado p/ tx', tx);
            }
          } catch (e:any) { console.warn('[OCPP] completeRemoteStopForTx falhou:', e?.message || e); }

          try { this.registry.clearTx(tx); } catch (e:any) { console.warn('[OCPP] clearTx falhou:', e?.message || e); }

          // 🔔 realtime: session.stopped já existia
          try {
            publish({ type: 'session.stopped', chargeBoxId, transactionId: tx, stoppedAt: stoppedAt.toISOString(), reason: p?.reason ?? 'Local' });
          } catch (e:any) { console.warn('[OCPP] publish session.stopped falhou:', e?.message || e); }

          // **NOVO**: devolver status "Available" para o connector 1 (se seu ambiente mapear isso diferente, ajuste)
          const connectorId = Number(p?.connectorId) || 1;
          this.emitStatusChanged(chargeBoxId, connectorId, 'Available', stoppedAt.toISOString());
          return;
        }

        case 'StatusNotification': {
          ack();

          try {
            const connectorId = Number(p?.connectorId) || 0;
            const when = p?.timestamp || new Date().toISOString();

            // atualiza snapshot em memória
            this.registry.setConnectorStatus(
              chargeBoxId,
              connectorId,
              p?.status ?? 'Unknown',
              p?.errorCode ?? '',
              when
            );

            // 🔔 (opcional) push de status para frontend
            publish({
              type: 'status.changed',
              chargeBoxId,
              connectorId,
              status: p?.status ?? 'Unknown',
              updatedAt: when
            });
          } catch (e:any) {
            // segue o jogo, status em memória é best-effort
          }

          try {
            await insertEvento({
              tipo: 'StatusNotification',
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: null
            });
          } catch (e:any) {
            console.warn('[OCPP] insertEvento StatusNotification falhou:', e?.message || e);
          }
          return;
        }

        case 'Heartbeat': {
          ok({ currentTime: new Date().toISOString() });

          try { this.registry.setHeartbeat(chargeBoxId); } catch {}

          // persiste para "onlineRecently"
          try {
            await insertEvento({
              tipo: 'Heartbeat',
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: null
            });
          } catch (e:any) {
            console.warn('[OCPP] insertEvento Heartbeat falhou:', e?.message || e);
          }

          // 🔔 (opcional) push de heartbeat
          try {
            publish({ type: 'heartbeat', chargeBoxId, at: new Date().toISOString() });
          } catch (e:any) {
            console.warn('[OCPP] publish heartbeat falhou:', e?.message || e);
          }
          return;
        }

        case 'DataTransfer':
        case 'DiagnosticsStatusNotification':
        case 'FirmwareStatusNotification': {
          ok({ status: 'Accepted' });
          try {
            await insertEvento({
              tipo: action,
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: null
            });
          } catch (e:any) {
            console.warn(`[OCPP] insertEvento ${action} falhou:`, e?.message || e);
          }
          return;
        }

        default: {
          // ações não tratadas especificamente: só ack + log
          ack();
          try {
            await insertEvento({
              tipo: action,
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: null
            });
          } catch (e:any) {
            console.warn('[OCPP] insertEvento (default) falhou:', e?.message || e);
          }
          return;
        }
      }
    } catch (err:any) {
      console.error('[OCPP] handleCall error (sem sendError):', {
        chargeBoxId, action, err: err?.message || err
      });
    }
  }

  private async handleStartTransaction(chargeBoxId: string, p: any) {
    const startedAt = p?.timestamp ? new Date(p.timestamp) : new Date();
    const connectorId = Number(p?.connectorId) || 1;
    const idTag = p?.idTag ?? null;
    const meterStartWh = Number(p?.meterStart ?? 0);
    let transactionId = Math.floor(Date.now() / 1000) % 1_000_000_000;
    if (transactionId <= 0) transactionId = 1;

    this.registry.bindTx(transactionId, chargeBoxId);
    try { console.log('[OCPP-CSMS] StartTransaction.session.created', { chargeBoxId, transaction_id: transactionId }); } catch {}
    try { await upsertSessionStart({ transactionId, chargeBoxId, idTag, startedAt, connectorId, mode: null }); } catch (e:any) { console.warn('[OCPP] upsertSessionStart falhou:', e?.message || e); }
    try { telemetryManager.startSession({ transactionId, chargeBoxId, startedAt, meterStartWh, idTag }); } catch (e:any) { console.warn('[OCPP] telemetryManager.startSession falhou:', e?.message || e); }
    try { await insertEvento({ tipo: 'StartTransaction', payload: { ...p, transactionId }, chargeBoxId, idTag, transactionId }); } catch (e:any) { console.warn('[OCPP] insertEvento StartTransaction falhou:', e?.message || e); }
    try { publish({ type: 'session.started', chargeBoxId, transactionId, idTag, startedAt: startedAt.toISOString() }); } catch (e:any) { console.warn('[OCPP] publish session.started falhou:', e?.message || e); }
    this.emitStatusChanged(chargeBoxId, connectorId, 'Charging', startedAt.toISOString());
    try { console.log('[OCPP-CSMS] StartTransaction.conf', { chargeBoxId, transactionId }); } catch {}
    return { transactionId, transaction_id: transactionId, idTagInfo: { status: 'Accepted' } };
  }


  private sendCall(ws: WebSocket, action: string, payload: any) {
    const uid = crypto.randomUUID().replace(/-/g, '');
    const frame: OcppFrame = [2, uid, action, payload];
    try { console.log(`[OCPP-CSMS] Call.sending direction=out action=${action} uniqueId=${uid} payload=${JSON.stringify(payload)}`); } catch {}
    ws.send(JSON.stringify(frame));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(uid);
        reject(new Error(`timeout waiting CallResult for ${action}`));
      }, OCPP_CALL_TIMEOUT_MS);
      this.pending.set(uid, { resolve, reject, timer });
    });
  }

  private sendResult(ws: WebSocket, uid: string, payload: any) {
    const frame: OcppFrame = [3, uid, payload];
    try { console.log(`[OCPP-CSMS] CallResult.sending direction=out uniqueId=${uid} payload=${JSON.stringify(payload)}`); } catch {}
    ws.send(JSON.stringify(frame));
  }
}

export const csms = new OcppCsms();
