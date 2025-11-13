// services/orchestrator-api/src/ocpp/registry.ts
import { WebSocket } from 'ws';

export type CbId = string;

export type ConnectorState = {
  status: string;
  errorCode: string;
  updatedAt: string; // ISO
};

export class ConnectionRegistry {
  // WS por chargeBoxId
  private peers = new Map<CbId, WebSocket>();
  // TX -> owner (cbid)
  private txOwner = new Map<number, CbId>();
  // Último TX visto por chargeBoxId
  private lastTxByCbid = new Map<CbId, number>();

  // Status e heartbeat em memória (debug)
  private connector = new Map<CbId, Map<number, ConnectorState>>();
  private lastHeartbeat = new Map<CbId, string>();
  private heartbeatInterval = new Map<CbId, number>();

  /* ========== Peers (WS) ========== */
  setPeer(cbid: CbId, ws: WebSocket) { this.peers.set(cbid, ws); }
  delPeer(cbid: CbId) { this.peers.delete(cbid); }
  getPeer(cbid: CbId) { return this.peers.get(cbid); }
  listPeers(): CbId[] { return Array.from(this.peers.keys()); }
  isOnline(cbid: CbId): boolean { return this.peers.has(cbid); }

  /* ========== TX owner bindings ========== */
  bindTx(tx: number, cbid: CbId) {
    if (!Number.isFinite(tx) || tx <= 0) return;
    this.txOwner.set(tx, cbid);
    this.lastTxByCbid.set(cbid, tx);
  }
  resolveTx(tx: number): CbId | undefined { return this.txOwner.get(tx); }
  clearTx(tx: number) {
    const cb = this.txOwner.get(tx);
    if (cb) this.lastTxByCbid.delete(cb);
    this.txOwner.delete(tx);
  }
  listTxBindings(): Array<{ transactionId: number; chargeBoxId: CbId }> {
    return Array.from(this.txOwner.entries()).map(([transactionId, chargeBoxId]) => ({ transactionId, chargeBoxId }));
  }
  getLastTxForChargeBox(cbid: CbId): number | undefined {
    return this.lastTxByCbid.get(cbid);
  }

  /* ==== Back-compat aliases (não quebrar chamadas antigas) ==== */
  bindTransaction(tx: number, cbid: CbId) { this.bindTx(tx, cbid); }
  unbindTransaction(tx: number) { this.clearTx(tx); }
  getLastTx(cbid: CbId): number | undefined { return this.getLastTxForChargeBox(cbid); }

  /* ========== Status por conector ========== */
  setConnectorStatus(cbid: CbId, connectorId: number, status: string, errorCode = '', whenISO?: string) {
    const m = this.connector.get(cbid) ?? new Map<number, ConnectorState>();
    m.set(connectorId, { status, errorCode, updatedAt: whenISO ?? new Date().toISOString() });
    this.connector.set(cbid, m);
  }
  getConnectorStatuses(cbid: CbId): Array<{ connectorId: number } & ConnectorState> {
    const m = this.connector.get(cbid);
    if (!m) return [];
    return Array.from(m.entries()).map(([connectorId, v]) => ({ connectorId, ...v }));
  }
  getConnectorStatus(cbid: CbId, connectorId: number): (ConnectorState & { connectorId: number }) | undefined {
    const m = this.connector.get(cbid);
    const v = m?.get(connectorId);
    return v ? { connectorId, ...v } : undefined;
  }

  /* ========== Heartbeat ========== */
  setHeartbeat(cbid: CbId, whenISO?: string) {
    this.lastHeartbeat.set(cbid, whenISO ?? new Date().toISOString());
  }
  getHeartbeat(cbid: CbId): string | undefined {
    return this.lastHeartbeat.get(cbid);
  }
  // Alias utilizado pelos handlers HTTP antigos
  getLastHeartbeat(cbid: CbId): string | undefined {
    return this.getHeartbeat(cbid);
  }

  /* ========== Snapshot para /debug/status ========== */
  // Aceita um 2º argumento opcional para não quebrar calls antigas (ignorado).
  getStatusSnapshot(cbid: CbId, _legacy?: unknown) {
    return {
      chargeBoxId: cbid,
      online: this.isOnline(cbid),
      lastHeartbeat: this.getHeartbeat(cbid) ?? null,
      heartbeatInterval: this.heartbeatInterval.get(cbid) ?? null,
      connectors: this.getConnectorStatuses(cbid),
      lastTransactionId: this.getLastTxForChargeBox(cbid) ?? null,
    };
  }

  setHeartbeatInterval(cbid: CbId, intervalSec: number) {
    if (Number.isFinite(intervalSec) && intervalSec > 0) this.heartbeatInterval.set(cbid, intervalSec);
  }
  getHeartbeatInterval(cbid: CbId): number | undefined {
    return this.heartbeatInterval.get(cbid);
  }
}

// Adapter para quem ainda importa OcppRegistry (continua funcionando)
export class OcppRegistry extends ConnectionRegistry {}
