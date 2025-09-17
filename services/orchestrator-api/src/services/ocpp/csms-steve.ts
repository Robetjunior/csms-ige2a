// src/services/ocpp/csms-steve.ts
import axios, { AxiosInstance } from "axios";

export type ChangeAvailabilityType = "Operative" | "Inoperative";

export interface RemoteStartArgs {
  idTag: string;
  connectorId?: number;
  reservationId?: number;
}
export interface ReserveNowArgs {
  idTag: string;
  connectorId: number;
  reservationId: number;
  expiryDate: string; // ISO
}

function required(name: string, v?: string) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const STEVE_URL = required("STEVE_URL", process.env.STEVE_URL);
const STEVE_ACTIONS_PREFIX = process.env.STEVE_ACTIONS_PREFIX || "/actions";
const STEVE_USER = process.env.STEVE_USER || "";
const STEVE_PASS = process.env.STEVE_PASS || "";

function makeClient(): AxiosInstance {
  const baseURL = STEVE_URL.replace(/\/+$/,"") + STEVE_ACTIONS_PREFIX;
  const auth = STEVE_USER && STEVE_PASS ? { username: STEVE_USER, password: STEVE_PASS } : undefined;

  return axios.create({
    baseURL,
    timeout: 15000,
    auth,
    headers: { "Content-Type": "application/json" },
    // se houver proxy/certificados, ajuste aqui
  });
}

const http = makeClient();

async function okOrThrow<T>(promise: Promise<{ data: T }>, op: string) {
  try {
    const r = await promise;
    return r.data;
  } catch (e: any) {
    const msg = e?.response?.data || e?.message || "unknown_error";
    throw new Error(`SteVe ${op} failed: ${JSON.stringify(msg)}`);
  }
}

export const csmsSteve = {
  // POST { chargeBoxId, idTag, connectorId?, reservationId? }
  async remoteStart(chargeBoxId: string, args: RemoteStartArgs) {
    return okOrThrow(
      http.post(`/remoteStartTransaction`, { chargeBoxId, ...args }),
      "remoteStartTransaction"
    );
  },

  // POST { transactionId }
  async remoteStop(transactionId: number) {
    return okOrThrow(
      http.post(`/remoteStopTransaction`, { transactionId }),
      "remoteStopTransaction"
    );
  },

  // POST { chargeBoxId, connectorId, idTag, reservationId, expiryDate }
  async reserveNow(chargeBoxId: string, args: ReserveNowArgs) {
    return okOrThrow(
      http.post(`/reserveNow`, { chargeBoxId, ...args }),
      "reserveNow"
    );
  },

  // POST { reservationId }
  async cancelReservation(reservationId: number) {
    return okOrThrow(
      http.post(`/cancelReservation`, { reservationId }),
      "cancelReservation"
    );
  },

  // POST { chargeBoxId, connectorId, type }   // connectorId = 0 => todos
  async changeAvailability(chargeBoxId: string, connectorId: number, type: ChangeAvailabilityType) {
    return okOrThrow(
      http.post(`/changeAvailability`, { chargeBoxId, connectorId, type }),
      "changeAvailability"
    );
  },
};
