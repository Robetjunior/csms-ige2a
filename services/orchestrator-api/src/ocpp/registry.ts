import { WebSocket } from 'ws';

export type CbId = string;

export type ConnectorState = {
  status: string;
  errorCode: string;
  updatedAt: string; // ISO
};

export class ConnectionRegistry {
  // ---- Conexões WS (CP online)
  private peers = new Map<CbId, WebSocket>();                 // chargeBoxId -> WebSocket

  // ---- Mapeamentos de transação
  private txOwner = new Map<number, CbId>();                   // transactionId -> chargeBoxId
  private lastTxByCb = new Map<CbId, number>();                // chargeBoxId -> último tx

  // ---- Telemetria em memória (debug/observabilidade)
  private connectorStates = new Map<CbId, Map<number, ConnectorState>>(); // cb -> (connectorId -> state)
  private lastHeartbeat = new Map<CbId, string>();                        // cb -> ISO time

  /* ========== Peers (WS) ========== */
  setPeer(cbid: CbId, ws: WebSocket) {
    this.peers.set(cbid, ws);
  }
  delPeer(cbid: CbId) {
    this.peers.delete(cbid);
    // opcional: poderia também limpar telemetria em memória para este CP
    // this.connectorStates.delete(cbid);
    // this.lastTxByCb.delete(cbid);
    // this.lastHeartbeat.delete(cbid);
  }
  getPeer(cbid: CbId) {
    return this.peers.get(cbid);
  }
  listPeers(): CbId[] {
    return Array.from(this.peers.keys());
  }

  /* ========== TX owner bindings ========== */
  bindTx(tx: number, cbid: CbId) {
    this.txOwner.set(tx, cbid);
    this.lastTxByCb.set(cbid, tx);
  }

  resolveTx(tx: number): CbId | undefined {
    return this.txOwner.get(tx);
  }

  clearTx(tx: number) {
    const cb = this.txOwner.get(tx);
    this.txOwner.delete(tx);
    if (cb && this.lastTxByCb.get(cb) === tx) {
      this.lastTxByCb.delete(cb);
    }
  }

  listTxBindings(): Array<{ transactionId: number; chargeBoxId: CbId }> {
    return Array.from(this.txOwner.entries()).map(([transactionId, chargeBoxId]) => ({
      transactionId,
      chargeBoxId,
    }));
  }

  getLastTxForChargeBox(cbid: CbId): number | undefined {
    return this.lastTxByCb.get(cbid);
  }

  /* ========== Status por conector ========== */
  setConnectorStatus(
    cbid: CbId,
    connectorId: number,
    status: string,
    errorCode: string = '',
    whenISO?: string
  ) {
    let m = this.connectorStates.get(cbid);
    if (!m) {
      m = new Map<number, ConnectorState>();
      this.connectorStates.set(cbid, m);
    }
    m.set(connectorId, {
      status,
      errorCode,
      updatedAt: whenISO ?? new Date().toISOString(),
    });
  }

  /** Retorna um dicionário { "<connectorId>": { status, errorCode, updatedAt } } */
  getConnectorStatuses(cbid: CbId): Record<string, ConnectorState> {
    const m = this.connectorStates.get(cbid);
    if (!m) return {};
    const out: Record<string, ConnectorState> = {};
    for (const [cid, state] of m.entries()) out[String(cid)] = state;
    return out;
    // Se preferir array, troque por:
    // return Array.from(m.entries()).map(([connectorId, v]) => ({ connectorId, ...v }));
  }

  /* ========== Heartbeat ========== */
  setHeartbeat(cbid: CbId, whenISO?: string) {
    this.lastHeartbeat.set(cbid, whenISO ?? new Date().toISOString());
  }

  /** Nome alinhado ao csms.getLastHeartbeat */
  getLastHeartbeat(cbid: CbId): string | undefined {
    return this.lastHeartbeat.get(cbid);
  }
}
