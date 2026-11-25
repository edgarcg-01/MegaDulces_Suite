/**
 * `[BFU.4.5.6]` **Los hechos de cada renglón de la descarga del banco de un periodo**, para decidir su área y si está
 * explicado (`leerFila`, en `cobertura-de-categoria.ts`). Es la ÚNICA consulta de esos hechos: la usan la cifra
 * «quién explica cada peso» del diagnóstico y el filtro por área de la lista de movimientos, para que el número y la
 * lista que abre cuenten lo mismo.
 *
 * Universo: el del motor de categoría (`sync_source = 'banco'`, sin borrar), el mismo de `cobertura_categoria`.
 *   · documento = casado con un documento de Kepler (`bank_recon_matches`);
 *   · pago      = ligado a un pago del Calendario EJECUTADO (`payment_allocations.paid_bank_movement_id`; sólo las
 *                 ejecutadas lo tienen: 192 de 275, medido el 2026-11-24);
 *   · cliente   = cliente declarado (`customer_code`, CC.11).
 */
import type { Knex } from 'knex';
import type { FilaDeCobertura } from './cobertura-de-categoria';

export interface HechosDelRenglon extends FilaDeCobertura { id: string }

export async function leerHechosDelPeriodo(trx: Knex | Knex.Transaction, period: string): Promise<HechosDelRenglon[]> {
  const filas = await trx('finance.bank_movements as bm')
    .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
    .leftJoin('finance.movement_categories as mc', 'mc.id', 'bm.category_id')
    .where('st.period', period).whereNull('bm.deleted_at').where('bm.sync_source', 'banco')
    .select('bm.id', trx.raw('(bm.category_id IS NOT NULL) AS con_categoria'), trx.raw('bm.category_reason AS motivo'),
      trx.raw(`bm.category_evidence->>'responsable' AS responsable`), trx.raw(`to_char(bm.movement_date, 'YYYY-MM-DD') AS fecha`),
      trx.raw('mc.owner_department_code AS area'), trx.raw('(bm.amount_in > 0) AS entra'),
      trx.raw('mc.code AS categoria'), 'bm.classified_by', trx.raw(`bm.category_evidence->>'fuente' AS fuente`),
      trx.raw('EXISTS (SELECT 1 FROM finance.bank_recon_matches r WHERE r.bank_movement_id = bm.id) AS documento'),
      trx.raw(`EXISTS (SELECT 1 FROM finance.payment_allocations pa WHERE pa.paid_bank_movement_id = bm.id AND pa.status = 'executed') AS pago`),
      trx.raw('(bm.customer_code IS NOT NULL) AS cliente'),
      trx.raw('1 AS n'), trx.raw('(bm.amount_in + bm.amount_out)::numeric AS monto'));
  return filas as HechosDelRenglon[];
}
