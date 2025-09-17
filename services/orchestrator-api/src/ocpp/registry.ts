// services/orchestrator-api/src/ocpp/registry.ts
import { WebSocket } from 'ws';

export type CbId = string;

type ConnectorState = {
  status: string;
  errorCode: string;
  updatedAt: string; // ISO
};

export class ConnectionRegistry {
  private peers = new Map<CbId, WebSocket>();               // chargeBoxId -> WebSocket
  private txOwner = new Map<number, CbId>();                 // transactionId -> chargeBoxId
  private lastTxByCbid = new Map<CbId, number>();            // chargeBoxId -> last tx id

  // Status em memória (debug/observabilidade)
  private connector = new Map<CbId, Map<number, ConnectorState>>(); // cbid -> (connectorId -> state)
  private lastHeartbeat = new Map<CbId, string>();                  // cbid -> ISO time

  /* ========== Peers (WS) ========== */
  setPeer(cbid: CbId, ws: WebSocket) { this.peers.set(cbid, ws); }
  delPeer(cbid: CbId) { this.peers.delete(cbid); }
  getPeer(cbid: CbId) { return this.peers.get(cbid); }
  listPeers(): CbId[] { return Array.from(this.peers.keys()); }
  isOnline(cbid: CbId): boolean { return this.peers.has(cbid); }

  /* ========== TX owner bindings ========== */
  bindTx(tx: number, cbid: CbId) {
    this.txOwner.set(tx, cbid);
    this.lastTxByCbid.set(cbid, tx);
  }
  resolveTx(tx: number): CbId | undefined { return this.txOwner.get(tx); }
  clearTx(tx: number) { this.txOwner.delete(tx); }

  listTxBindings(): Array<{ transactionId: number; chargeBoxId: CbId }> {
    return Array.from(this.txOwner.entries()).map(([transactionId, chargeBoxId]) => ({ transactionId, chargeBoxId }));
  }

  getLastTxForChargeBox(cbid: CbId): number | undefined {
    return this.lastTxByCbid.get(cbid);
  }

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
  /** Alias para compatibilidade com os handlers HTTP existentes */
  getLastHeartbeat(cbid: CbId): string | undefined {
    return this.getHeartbeat(cbid);
  }

  /* ========== Snapshot para /debug/status ========== */
  getStatusSnapshot(cbid: CbId) {
    return {
      chargeBoxId: cbid,
      online: this.isOnline(cbid),
      heartbeat: this.getHeartbeat(cbid) ?? null,
      connectors: this.getConnectorStatuses(cbid),
      lastTransactionId: this.getLastTxForChargeBox(cbid) ?? null,
    };
  }
}
