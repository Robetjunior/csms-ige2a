  import { Router, Request, Response } from 'express';
  import { listSessions } from '../services/repo';
  import { pg } from '../db';

  const router = Router();

  /**
   * GET /v1/sessions
   * Filtros: charge_box_id, id_tag, transaction_id, status (active|completed), from, to
   * Paginação: limit, offset
   * Ordenação: sort (asc|desc) por started_at
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
    const {
      charge_box_id,
      id_tag,
      transaction_id,
      status,
      from,
      to,
      limit = '50',
      offset = '0',
      sort = 'desc',
    } = req.query as Record<string, string | undefined>;

    const result = await listSessions({
      chargeBoxId: charge_box_id,
      idTag: id_tag,
      transactionId: transaction_id ? Number(transaction_id) : undefined,
      status: status === 'active' || status === 'completed' ? (status as 'active'|'completed') : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Math.min(Math.max(parseInt(String(limit) || '50', 10), 1), 500),
      offset: Math.max(parseInt(String(offset) || '0', 10), 0),
      sort: (sort || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    });

    return res.json(result);
  } catch (err: any) {
    console.error('[GET /v1/sessions] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/sessions/:transactionId
 * Retorna o estado de uma sessão específica.
 */
router.get('/:transactionId', async (req: Request, res: Response) => {
  try {
    const tx = Number(req.params.transactionId);
    if (!Number.isFinite(tx)) {
      return res.status(400).json({ error: 'invalid_transaction_id' });
    }

    const sql = `
      SELECT
        (s.transaction_id)::int AS transaction_id,
        s.charge_box_id,
        s.id_tag,
        s.started_at,
        s.stopped_at,
        s.stop_reason,
        CASE WHEN s.stopped_at IS NULL THEN 'active' ELSE 'completed' END AS status,
        EXTRACT(EPOCH FROM (COALESCE(s.stopped_at, now()) - s.started_at))::int AS duration_seconds
      FROM orchestrator.sessions s
      WHERE s.transaction_id = $1::int
      ORDER BY s.id DESC
      LIMIT 1
    `;
    const { rows } = await pg.query(sql, [tx]);

    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json(rows[0]);
  } catch (err: any) {
    console.error('[GET /v1/sessions/:id] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
