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
 * - Suporta múltiplas chaves via ORCH_API_KEY="k1,k2,k3"
 * - Ignora pré-flight CORS (OPTIONS)
 */
export function requireApiKey() {
  const keys = parseKeys(process.env.ORCH_API_KEY);

  if (keys.size === 0) {
    // Bloqueia tudo por segurança se ninguém configurou ORCH_API_KEY.
    // Se quiser liberar em dev, troque por um console.warn e next().
    // eslint-disable-next-line no-console
    console.error('[auth] ORCH_API_KEY não configurada. Defina pelo menos 1 chave (pode ser múltiplas, separadas por vírgula).');
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