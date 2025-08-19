// src/routes/commands.ts
import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';

const router = Router();

const pool = new Pool({
  connectionString: process.env.POSTGRES_URI,
});

// validação do corpo
const RemoteStopSchema = z.object({
  transactionId: z.number().int().positive(),
});

/**
 * POST /v1/commands/remoteStop
 * Body: { transactionId: number }
 * Headers (opcional): X-API-Key: <chave>
 */
router.post('/remoteStop', async (req: Request, res: Response) => {
  try {
    // auth opcional (igual padrão das outras rotas)
    const expectedKey = process.env.ORCH_API_KEY ?? '';
    if (expectedKey) {
      const provided = (req.headers['x-api-key'] as string | undefined) || '';
      if (provided !== expectedKey) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    // validação do payload
    const parsed = RemoteStopSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_payload',
        details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }
    const tx = parsed.data.transactionId;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) sessão ativa
      const sessionSql = `
        SELECT id, transaction_id, charge_box_id, stopped_at
        FROM orchestrator.sessions
        WHERE transaction_id = $1::int
        ORDER BY id DESC
        LIMIT 1
      `;
      const sres = await client.query(sessionSql, [tx]);
      if (sres.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Sessão não encontrada' });
      }
      const session = sres.rows[0];
      if (session.stopped_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Sessão já finalizada' });
      }

      // 2) idempotência — já existe RemoteStop aberto para esse tx?
      const existing = await client.query(
        `SELECT id, status
           FROM orchestrator.commands
          WHERE command_type='RemoteStop'
            AND transaction_id=$1::int
            AND status IN ('pending','sent','accepted')
          ORDER BY id DESC
          LIMIT 1`,
        [tx],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        await client.query('ROLLBACK');
        return res.status(200).json({
          commandId: row.id,
          status: row.status,
          idempotentDuplicate: true,
        });
      }

      // 3) inserir comando
      const insSql = `
        INSERT INTO orchestrator.commands
          (command_type, transaction_id, charge_box_id, requested_by, status, payload, session_fk)
        VALUES
          ('RemoteStop', $1::int, $2::text, 'api', 'pending', jsonb_build_object('transactionId', $1::int), $3::bigint)
        RETURNING id
      `;
      const cres = await client.query(insSql, [tx, session.charge_box_id, session.id]);
      const commandId: number = cres.rows[0].id;

      // 4) marcar como 'sent'
      await client.query(
        `UPDATE orchestrator.commands SET status = 'sent', updated_at = now() WHERE id = $1::bigint`,
        [commandId],
      );

      await client.query('COMMIT');

      return res.status(202).json({
        commandId,
        status: 'sent',
        message: 'RemoteStop solicitado. Aguarde confirmação do CSMS/CP.',
      });
    } catch (err: any) {
      await pool.query('ROLLBACK'); // fallback se o client falhar
      console.error('[remoteStop] error:', err);
      return res.status(500).json({ error: 'internal_error' });
    } finally {
      // libera a conexão do pool
      try { (await pool.connect()).release(); } catch {}
    }
  } catch (err: any) {
    console.error('[remoteStop] outer error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * GET /v1/commands/:id
 * Detalhes do comando
 */
router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid_id' });

  const { rows } = await pool.query(
    `SELECT id, command_type, transaction_id, charge_box_id, status, payload, response, created_at, updated_at
       FROM orchestrator.commands
      WHERE id = $1::bigint`,
    [id],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  return res.json(rows[0]);
});

/**
 * GET /v1/commands?transaction_id=...
 * Lista comandos (filtra por tx opcional)
 */
router.get('/', async (req: Request, res: Response) => {
  const tx = req.query.transaction_id ? Number(req.query.transaction_id) : undefined;
  const params: any[] = [];
  const where: string[] = [];
  let i = 1;

  if (Number.isFinite(tx)) { where.push(`transaction_id = $${i++}::int`); params.push(tx); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, command_type, transaction_id, charge_box_id, status, created_at
       FROM orchestrator.commands
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT 100`,
    params,
  );
  return res.json(rows);
});

export default router;
