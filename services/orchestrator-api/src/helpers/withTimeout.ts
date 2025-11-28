const qTimeoutMs = Number(process.env.SB_TIMEOUT ?? process.env.SUPABASE_QUERY_TIMEOUT_MS ?? 1500);

export async function withTimeout<T>(p: Promise<T>, ms = qTimeoutMs): Promise<T | null> {
  return await Promise.race([
    p,
    new Promise<T | null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export { qTimeoutMs };