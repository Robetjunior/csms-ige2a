// src/services/deepLinkService.ts
import * as Linking from "expo-linking";

export type DeepLinkTarget =
  | { kind: "connector"; chargeBoxId: string; connectorId?: number }
  | { kind: "session"; transactionId: number; chargeBoxId?: string; connectorId?: number };

const SCHEME = "easyvolt";

export function buildConnectorLink(chargeBoxId: string, connectorId?: number) {
  const path = `cp/${encodeURIComponent(chargeBoxId)}`;
  const query = connectorId ? { connectorId: String(connectorId) } : undefined;
  return Linking.createURL(path, { scheme: SCHEME, queryParams: query });
}

export function buildSessionLink(tx: number, chargeBoxId?: string, connectorId?: number) {
  const path = `session/${tx}`;
  const query: Record<string, string> = {};
  if (chargeBoxId) query.chargeBoxId = chargeBoxId;
  if (connectorId != null) query.connectorId = String(connectorId);
  return Linking.createURL(path, { scheme: SCHEME, queryParams: Object.keys(query).length ? query : undefined });
}

// parse genérico (se já fez, mantenha; aqui é referência)
export function parse(url: string): DeepLinkTarget | null {
  if (!url) return null;
  const { hostname, path, queryParams } = Linking.parse(url);
  const p = (path || "").replace(/^\//, "");
  const parts = p.split("/");

  if (parts[0] === "cp" && parts[1]) {
    const chargeBoxId = decodeURIComponent(parts[1]);
    const connectorId = queryParams?.connectorId ? Number(queryParams.connectorId) : undefined;
    return { kind: "connector", chargeBoxId, connectorId };
  }

  if (parts[0] === "session" && parts[1] && /^\d+$/.test(parts[1])) {
    const tx = Number(parts[1]);
    const chargeBoxId = queryParams?.chargeBoxId as string | undefined;
    const connectorId = queryParams?.connectorId ? Number(queryParams.connectorId) : undefined;
    return { kind: "session", transactionId: tx, chargeBoxId, connectorId };
  }

  // suporte a hostname “cp” (easyvolt://cp/CP001)
  if (hostname === "cp" && parts[0]) {
    const chargeBoxId = decodeURIComponent(parts[0]);
    const connectorId = queryParams?.connectorId ? Number(queryParams.connectorId) : undefined;
    return { kind: "connector", chargeBoxId, connectorId };
  }

  return null;
}
