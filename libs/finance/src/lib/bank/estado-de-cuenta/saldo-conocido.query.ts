import type { Knex } from 'knex';
import { cierreDelDia } from './saldo-del-libro';

/** El último saldo conocido de una cuenta: con qué cerró qué día, y de dónde se sabe. */
export interface SaldoConocido {
  saldo: number;
  /** El día cuyo cierre es (YYYY-MM-DD). */
  fecha: string;
  /** `banco` = el último renglón de la descarga; `libro` = el cierre del libro reconstruido por la cadena de saldos. */
  fuente: 'banco' | 'libro';
}

/**
 * **El último saldo conocido de cada cuenta ANTES de `antesDe`**: primero la descarga del banco, si no, el libro.
 *
 * Es la regla de `EstadoDeCuentaService.saldoConocido` (`[CB.59]`), sacada aquí para que `[PGP.218]` (¿le alcanza a la
 * cuenta para sus cargos automáticos?) mida el saldo con el MISMO instrumento que Estados de cuenta (ADR-056: un
 * primitivo, no dos). Ese método ahora llama aquí.
 *
 *  · Banco: el renglón cronológicamente último (`movement_date`, `created_at`, `seq`) de la descarga.
 *  · Libro: el libro no guarda el orden dentro del día; el cierre del último día con saldo se reconstruye por la
 *    cadena (`cierreDelDia`). Si no se puede afirmar, la cuenta queda sin saldo (`null`): nunca un saldo inventado.
 *
 * Una consulta por fuente para todas las cuentas (antes, dos o tres por cuenta).
 */
export async function saldosConocidos(
  trx: Knex | Knex.Transaction, ids: readonly string[], antesDe: string,
): Promise<Map<string, SaldoConocido | null>> {
  const out = new Map<string, SaldoConocido | null>();
  const unicos = Array.from(new Set(ids));
  if (!unicos.length) return out;

  const delBanco = (await trx.raw(`
    SELECT p.id::text AS id, to_char(l.movement_date, 'YYYY-MM-DD') AS d, l.running_balance
      FROM unnest(?::uuid[]) AS p(id)
      CROSS JOIN LATERAL (
        SELECT sl.movement_date, sl.running_balance FROM finance.bank_statement_lines sl
         WHERE sl.bank_account_id = p.id AND sl.movement_date < ?
         ORDER BY sl.movement_date DESC, sl.created_at DESC, sl.seq DESC LIMIT 1) l`,
  [unicos, antesDe])).rows as { id: string; d: string; running_balance: string | null }[];
  for (const f of delBanco) {
    // Medido el 2026-11-25: 0 de 4,382 renglones de la descarga sin saldo. Si apareciera uno, no es un saldo en cero.
    if (f.running_balance !== null) out.set(f.id, { saldo: Number(f.running_balance), fecha: f.d, fuente: 'banco' });
  }

  const sinBanco = unicos.filter((id) => !out.has(id));
  if (sinBanco.length) {
    const filas = (await trx.raw(`
      WITH ult AS (
        SELECT p.id, u.d FROM unnest(?::uuid[]) AS p(id)
        CROSS JOIN LATERAL (
          SELECT bm.movement_date AS d FROM finance.bank_movements bm
           WHERE bm.bank_account_id = p.id AND bm.deleted_at IS NULL AND bm.running_balance IS NOT NULL AND bm.movement_date < ?
           ORDER BY bm.movement_date DESC LIMIT 1) u)
      SELECT ult.id::text AS id, to_char(ult.d, 'YYYY-MM-DD') AS d, bm.amount_in, bm.amount_out, bm.running_balance
        FROM ult JOIN finance.bank_movements bm
          ON bm.bank_account_id = ult.id AND bm.movement_date = ult.d AND bm.deleted_at IS NULL`,
    [sinBanco, antesDe])).rows as { id: string; d: string; amount_in: string; amount_out: string; running_balance: string | null }[];
    for (const id of sinBanco) {
      const delDia = filas.filter((f) => f.id === id);
      const saldo = delDia.length ? cierreDelDia(delDia) : null;
      out.set(id, saldo === null ? null : { saldo, fecha: delDia[0].d, fuente: 'libro' });
    }
  }
  return out;
}
