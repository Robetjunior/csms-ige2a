// services/repo_supabase.ts
import { sb } from '../supabase'; // createClient(SUPABASE_URL, SERVICE_KEY)

// 1) inserir evento
export async function insertEvento(p: {
  tipo: string; payload: any; chargeBoxId?: string|null; transactionId?: number|null; idTag?: string|null; createdAt?: string;
}) {
  const { data, error } = await sb.rpc('orchestrator.insert_evento', {
    p_tipo: p.tipo,
    p_transaction_id: p.transactionId ?? null,
    p_charge_box_id: p.chargeBoxId ?? null,
    p_id_tag: p.idTag ?? null,
    p_payload: p.payload ?? {},
    p_created_at: p.createdAt ?? null
  });
  if (error) throw error;
  return { id: data as number, duplicate: false };
}

// 2) start session
export async function upsertSessionStart(p: {
  transactionId: number; chargeBoxId?: string|null; idTag?: string|null; startedAt: Date; mode?: string|null; connectorId?: number|null;
}) {
  const { data, error } = await sb.rpc('orchestrator.upsert_session_start', {
    p_transaction_id: p.transactionId,
    p_charge_box_id: p.chargeBoxId ?? null,
    p_id_tag: p.idTag ?? null,
    p_started_at: p.startedAt.toISOString(),
    p_mode: p.mode ?? null,
    p_connector_id: p.connectorId ?? null
  });
  if (error) throw error;
  return { id: data as number };
}

// 3) stop session
export async function stopSession(p: {
  transactionId: number; stoppedAt?: Date; stopReason?: string|null; energyKwh?: number|null; revenueBr?: number|null;
}) {
  const { data, error } = await sb.rpc('orchestrator.stop_session', {
    p_transaction_id: p.transactionId,
    p_stopped_at: (p.stoppedAt ?? new Date()).toISOString(),
    p_stop_reason: p.stopReason ?? null,
    p_energy_kwh: p.energyKwh ?? null,
    p_revenue_br: p.revenueBr ?? null
  });
  if (error) throw error;
  return { updated: data as boolean };
}

// 4) completa RemoteStop
export async function completeRemoteStopForTx(params: { transactionId: number; response: any }) {
  const { transactionId, response } = params;
  const now = new Date().toISOString();

  // 1) Atualiza TODOS os RemoteStop desse tx que estejam pending/sent
  const upd = await sb
    .from('commands')
    .update({ status: 'accepted', response, updated_at: now })
    .eq('command_type', 'RemoteStop')
    .eq('transaction_id', transactionId)
    .in('status', ['pending', 'sent'])
    .select('id,status');

  if (upd.error) {
    // Deixa logar, mas não derruba o fluxo OCPP
    console.warn('[repo] completeRemoteStopForTx UPDATE error:', upd.error.message);
    return { updated: false, reason: upd.error.message };
  }

  // 2) Se nada foi atualizado, pode ser que já esteja accepted — checa só pra log
  if (!upd.data || upd.data.length === 0) {
    const chk = await sb
      .from('commands')
      .select('id,status')
      .eq('command_type', 'RemoteStop')
      .eq('transaction_id', transactionId)
      .order('id', { ascending: false })
      .limit(1);
    if (chk.error) {
      console.warn('[repo] completeRemoteStopForTx CHECK error:', chk.error.message);
      return { updated: false, reason: 'no_rows_and_check_failed' };
    }
    if (chk.data?.[0]?.status === 'accepted') {
      return { updated: false, reason: 'already_accepted' };
    }
    return { updated: false, reason: 'no_matching_rows' };
  }

  return { updated: true, ids: upd.data.map(r => r.id) };
}