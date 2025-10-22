// src/middleware/apiKey.ts
import type { Request, Response, NextFunction } from 'express';

function parseKeys(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

/**
 * Exige header X-API-Key em todas as rotas onde for aplicado.
 * - Suporta múltiplas chaves via ORCH_API_KEY="k1,k2,k3" e API_KEYS
 * - Ignora pré-flight CORS (OPTIONS)
 */
export function requireApiKey() {
  const keys = new Set<string>();
  // Suporta ambas variáveis por compatibilidade
  const orch = parseKeys(process.env.ORCH_API_KEY);
  const list = parseKeys(process.env.API_KEYS);
  orch.forEach(k => keys.add(k));
  list.forEach(k => keys.add(k));

  if (keys.size === 0) {
    // Bloqueia tudo por segurança se ninguém configurou ORCH_API_KEY/API_KEYS.
    // eslint-disable-next-line no-console
    console.error('[auth] Nenhuma API key configurada. Defina ORCH_API_KEY ou API_KEYS com pelo menos 1 chave.');
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next(); // deixa o CORS lidar com o preflight

    const header = req.headers['x-api-key']; // string | string[] | undefined
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || !keys.has(provided)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}