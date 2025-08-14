// src/services/repo.ts
import { pg } from '../db';

type InsertEventoArgs = {
  tipo: string;
  payload: any;
  chargeBoxId: string | null;
  transactionId: number | null;
  idTag: string | null;
};

export async function insertEvento(args: InsertEventoArgs): Promise<void> {
  const { tipo, payload, chargeBoxId, transactionId, idTag } = args;

  // Monta SQL dinâmico conforme as colunas existentes
  // (se você não adicionou as colunas novas, salva só tipo+payload)
  const hasExtendedCols = (chargeBoxId !== null) || (transactionId !== null) || (idTag !== null);

  if (hasExtendedCols) {
    const sql = `
      INSERT INTO public.eventos (tipo, payload, charge_box_id, transaction_id, id_tag)
      VALUES ($1, $2, $3, $4, $5)
    `;
    const params = [tipo, JSON.stringify(payload), chargeBoxId, transactionId, idTag];
    await pg.query(sql, params);
  } else {
    const sql = `
      INSERT INTO public.eventos (tipo, payload)
      VALUES ($1, $2)
    `;
    const params = [tipo, JSON.stringify(payload)];
    await pg.query(sql, params);
  }
}
