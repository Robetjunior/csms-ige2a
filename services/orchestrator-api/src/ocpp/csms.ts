import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';

import {
  OCPP_SUBPROTOCOL,
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

  /** Sobe o servidor OCPP sobre o mesmo HTTP server do Express */
  start(server: http.Server) {
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(OCPP_SUBPROTOCOL) ? OCPP_SUBPROTOCOL : false,
    });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      if (!url.pathname.startsWith(`${OCPP_PATH_PREFIX}/`)) return;
      this.wss!.handleUpgrade(req, socket, head, (ws) =>
        this.wss!.emit('connection', ws, req)
      );
    });

    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) =>
      this.handleConnection(ws, req)
    );

    console.log(`[OCPP] ready at ws://<host>:<port>${OCPP_PATH_PREFIX}/<CPID> (${OCPP_SUBPROTOCOL})`);
  }

  /* ============ PUBLIC API (comandos CSMS -> CP) ============ */

  async remoteStart(chargeBoxId: string, args: { idTag: string; connectorId?: number }) {
    const ws = this.registry.getPeer(chargeBoxId);
    if (!ws || ws.readyState !== ws.OPEN) throw new Error('charge_point_offline');
    return this.sendCall(ws, 'RemoteStartTransaction', {
      idTag: args.idTag,
      ...(args.connectorId ? { connectorId: args.connectorId } : {}),
    });
  }

  async remoteStop(transactionId: number) {
    const cbid = this.registry.resolveTx(transactionId);
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
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const chargeBoxId = decodeURIComponent(url.pathname.split('/').pop() || 'unknown');

    this.registry.setPeer(chargeBoxId, ws);
    console.log(`[OCPP] CP connected: ${chargeBoxId}`);

    const iv = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, OCPP_PING_MS);
    ws.on('close', () => {
      clearInterval(iv);
      this.registry.delPeer(chargeBoxId);
      console.log(`[OCPP] CP disconnected: ${chargeBoxId}`);
    });

    ws.on('message', async (raw: Buffer) => {
      let m: OcppFrame;
      try { m = JSON.parse(raw.toString()); } catch { return; }

      if (isCall(m)) {
        const [, uid, action, payload] = m;
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
        return;
      }

      if (isError(m)) {
        const [, uid, code, desc, details] = m;
        const p = this.pending.get(uid);
        if (p) { clearTimeout(p.timer); p.reject(new Error(`${code}: ${desc}`)); this.pending.delete(uid); }
        console.warn('[OCPP] CALLERROR', { uid, code, desc, details });
      }
    });
  }

  private async handleCall(ws: WebSocket, chargeBoxId: string, uid: string, action: string, p: any) {
    const ok  = (payload: any) => this.sendResult(ws, uid, payload);
    const ack = () => this.sendResult(ws, uid, {});

    try {
      switch (action) {
        case 'BootNotification': {
          ok({ status: 'Accepted', currentTime: new Date().toISOString(), interval: 180 });
          try {
            await insertEvento({ tipo: 'BootNotification', payload: p, chargeBoxId, idTag: null, transactionId: null });
          } catch (e:any) { console.warn('[OCPP] insertEvento BootNotification falhou:', e?.message || e); }
          return;
        }

        case 'Authorize': {
          ok({ idTagInfo: { status: 'Accepted' } });
          try {
            await insertEvento({ tipo: 'Authorize', payload: p, chargeBoxId, idTag: p?.idTag ?? null, transactionId: null });
          } catch (e:any) { console.warn('[OCPP] insertEvento Authorize falhou:', e?.message || e); }
          return;
        }

        case 'StartTransaction': {
          const startedAt = p?.timestamp ? new Date(p.timestamp) : new Date();
          let transactionId = Math.floor(Date.now() / 1000) % 1_000_000_000;
          if (transactionId <= 0) transactionId = 1;

          this.registry.bindTx(transactionId, chargeBoxId);

          ok({ transactionId, idTagInfo: { status: 'Accepted' } });

          try {
            await upsertSessionStart({ transactionId, chargeBoxId, idTag: p?.idTag ?? null, startedAt });
          } catch (e:any) { console.warn('[OCPP] upsertSessionStart falhou:', e?.message || e); }

          try {
            await insertEvento({
              tipo: 'StartTransaction',
              payload: { ...p, transactionId },
              chargeBoxId,
              idTag: p?.idTag ?? null,
              transactionId,
            });
          } catch (e:any) { console.warn('[OCPP] insertEvento StartTransaction falhou:', e?.message || e); }
          return;
        }

        case 'MeterValues': {
          ack();
          const tx = Number(p?.transactionId);
          if (Number.isFinite(tx) && tx > 0) this.registry.bindTx(tx, chargeBoxId);

          try {
            await insertEvento({
              tipo: 'MeterValues',
              payload: p,
              chargeBoxId,
              idTag: null,
              transactionId: Number.isFinite(tx) && tx > 0 ? tx : null
            });
          } catch (e:any) { console.warn('[OCPP] insertEvento MeterValues falhou:', e?.message || e); }
          return;
        }

        case 'StopTransaction': {
          const tx = Number(p?.transactionId);
          const stoppedAt = p?.timestamp ? new Date(p.timestamp) : new Date();

          ack();

          try {
            await stopSession({ transactionId: tx, stoppedAt, stopReason: p?.reason ?? 'Local' });
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
          return;
        }

        case 'StatusNotification': {
          ack();
          try {
            const connectorId = Number(p?.connectorId) || 0;
            const when = p?.timestamp || new Date().toISOString();
            this.registry.setConnectorStatus(
              chargeBoxId, connectorId, p?.status ?? 'Unknown', p?.errorCode ?? '', when
            );
          } catch {}
          try {
            await insertEvento({ tipo: 'StatusNotification', payload: p, chargeBoxId, idTag: null, transactionId: null });
          } catch (e:any) { console.warn('[OCPP] insertEvento StatusNotification falhou:', e?.message || e); }
          return;
        }

        case 'Heartbeat': {
          ok({ currentTime: new Date().toISOString() });
          try { this.registry.setHeartbeat(chargeBoxId); } catch {}
          return;
        }

        case 'DataTransfer':
        case 'DiagnosticsStatusNotification':
        case 'FirmwareStatusNotification': {
          ok({ status: 'Accepted' });
          try {
            await insertEvento({ tipo: action, payload: p, chargeBoxId, idTag: null, transactionId: null });
          } catch (e:any) { console.warn(`[OCPP] insertEvento ${action} falhou:`, e?.message || e); }
          return;
        }

        default: {
          ack();
          try {
            await insertEvento({ tipo: action, payload: p, chargeBoxId, idTag: null, transactionId: null });
          } catch (e:any) { console.warn('[OCPP] insertEvento (default) falhou:', e?.message || e); }
          return;
        }
      }
    } catch (err:any) {
      console.error('[OCPP] handleCall error (sem sendError):', { chargeBoxId, action, err: err?.message || err });
    }
  }

  private sendCall(ws: WebSocket, action: string, payload: any) {
    const uid = crypto.randomUUID().replace(/-/g, '');
    const frame: OcppFrame = [2, uid, action, payload];
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
    ws.send(JSON.stringify(frame));
  }
}

export const csms = new OcppCsms();
