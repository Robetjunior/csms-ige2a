export type OcppFrame = [2, string, string, any] | [3, string, any] | [4, string, string, string, any];

export const OCPP_SUBPROTOCOL = 'ocpp1.6';
export const OCPP_ACCEPTED_SUBPROTOCOLS = ['ocpp1.6', 'ocpp1.6j'] as const;
export const OCPP_PATH_PREFIX = process.env.OCPP_PATH_PREFIX ?? '/ocpp/CentralSystemService';
export const OCPP_PING_MS = Number(process.env.OCPP_PING_MS ?? '30000');
export const OCPP_CALL_TIMEOUT_MS = Number(process.env.OCPP_CALL_TIMEOUT_MS ?? '15000');

export function isCall(m: any): m is [2, string, string, any] { return Array.isArray(m) && m[0] === 2; }
export function isResult(m: any): m is [3, string, any]       { return Array.isArray(m) && m[0] === 3; }
export function isError(m: any): m is [4, string, string, string, any] { return Array.isArray(m) && m[0] === 4; }
