/* eslint-disable no-console */
/**
 * scripts/testSupabase.ts
 *
 * Exercita as RPCs criadas no Supabase + um health ping.
 * Usa SUPABASE_URL e SUPABASE_SERVICE_KEY do .env (ou variáveis do docker compose).
 *
 * Rodar:
 *   pnpm ts-node scripts/testSupabase.ts
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return v;
}

const SUPABASE_URL = reqEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || reqEnv('SUPABASE_ANON_KEY');

const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// helpers
const pp = (x: any) => JSON.stringify(x, null, 2);

async function runRpc<T = any>(name: string, args: Record<string, any> = {}) {
  const t0 = Date.now();
  const { data, error } = await sb.rpc<T>(name as any, args);
  const ms = Date.now() - t0;
  if (error) {
    console.error(`❌ ${name} ->`, error.message);
  } else {
    console.log(`✅ ${name} (${ms}ms):`);
    console.log(pp(data));
  }
  return { data, error };
}

// datas padrão (últimos 30 dias)
const now = new Date();
const toISO = (d: Date) => d.toISOString();
const minusDays = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const P_FROM = toISO(minusDays(30));
const P_TO   = toISO(now);

async function main() {
  console.log('== Supabase project ==', SUPABASE_URL);

  // 0) Health ping (se você criou essa RPC)
  await runRpc('health_ping'); // deve retornar 1

  // 1) Utilization
  await runRpc('metrics_utilization', {
    p_from: P_FROM,
    p_to: P_TO,
    p_charge_box_id: null, // ou "CB-123"
  });

  // 2) Reliability
  await runRpc('metrics_reliability', {
    p_from: P_FROM,
    p_to: P_TO,
  });

  // 3) Funnel
  await runRpc('metrics_funnel', {
    p_from: P_FROM,
    p_to: P_TO,
  });

  // 4) ARPU
  await runRpc('metrics_arpu', {
    p_from: P_FROM,
    p_to: P_TO,
  });

  // 5) Cohorts por mês (ano atual por padrão; você pode parametrizar na sua função)
  await runRpc('metrics_cohorts_monthly', {
    p_year: new Date().getUTCFullYear(),
  });

  // 6) Anomalias
  await runRpc('metrics_anomalies', {
    p_from: P_FROM,
    p_to: P_TO,
  });

  // 7) Forecast de receita (média móvel de N meses; default 3)
  await runRpc('metrics_forecast_revenue', {
    p_months: 3,
  });

  // 8) Overview (se você criou uma RPC consolidada; caso contrário, ignore)
  // await runRpc('metrics_overview', {
  //   p_from: P_FROM,
  //   p_to: P_TO,
  //   p_charge_box_id: null,
  // });

  console.log('\n🟢 Fim. Se alguma RPC retornou vazia, provavelmente faltam dados nas tabelas/views base.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
