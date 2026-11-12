import type { Knex } from 'knex';
import { descargaEnMovimientos, type MotivoSoloDescarga, type RenglonComparable } from './contra-el-libro';

/**
 * `[CB.64]` La descarga del banco DENTRO de Movimientos (Edgar, 2026-11-12: «hay que hacerlo una sola interfaz»).
 *
 * Lee los dos lados de un mes y los parea con la regla de la compuerta (`descargaEnMovimientos`): qué renglones
 * de la descarga no tiene el libro, y qué renglones del libro trae o no trae el banco. Sólo lee; no escribe en
 * `bank_movements` (eso sólo pasa al «usar el banco», CB.60b).
 *
 * Medido en prod el 2026-11-12 (noviembre): 1,974 renglones de la descarga en 38 ms y 2,253 del libro en 32 ms.
 *
 * ⚠️ Se lee con ±3 días de margen (±6 del lado del libro): un renglón del 1 puede casar con uno del 29 del mes
 * anterior. Pero sólo se reporta lo del mes: los renglones de la descarga y el resumen se cortan al periodo.
 */
export interface DescargaDelPeriodo {
  /** Renglones de la descarga (del mes) que el libro no tiene, con por qué. */
  solo: Map<string, MotivoSoloDescarga>;
  /** Renglones del libro que la descarga trae. */
  trae: Set<string>;
  /** Renglones del libro, dentro de lo que cubre un archivo, que la descarga no trae. */
  no_trae: Set<string>;
  /** Del mes y de las cuentas a la vista (no de la búsqueda ni los demás filtros). */
  resumen: { solo_descarga: number; no_trae: number; trae: number };
}

const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export async function leerDescargaDelPeriodo(trx: Knex.Transaction, periodo: string, cuentaId?: string): Promise<DescargaDelPeriodo | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) return null;
  const ini = `${periodo}-01`;
  const [y, m] = periodo.split('-').map(Number);
  const fin = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const enMes = (f: string) => f >= ini && f <= fin;
  const desde = sumarDias(ini, -3), hasta = sumarDias(fin, 3);

  const banco = (await trx('finance.bank_statement_lines')
    .whereBetween('movement_date', [desde, hasta])
    .modify((q) => { if (cuentaId) q.where('bank_account_id', cuentaId); })
    .select('id', 'bank_account_id', trx.raw("to_char(movement_date, 'YYYY-MM-DD') as fecha"), 'amount_in', 'amount_out', 'running_balance'))
    .map((b: RenglonComparable & { bank_account_id: string }) => b);
  if (!banco.length) return null;
  const ids: string[] = Array.from(new Set(banco.map((b) => b.bank_account_id)));

  // Una cuenta que ya usa el banco (CB.60b): lo del corte en adelante ya está en `bank_movements` con sync_source 'banco'.
  const conCorte = await trx.schema.withSchema('finance').hasColumn('bank_accounts', 'statement_source_since');
  const cortes = new Map<string, string | null>(conCorte
    ? (await trx('finance.bank_accounts').whereIn('id', ids).select('id', trx.raw("to_char(statement_source_since, 'YYYY-MM-DD') as corte")))
      .map((a: { id: string; corte: string | null }) => [a.id, a.corte])
    : []);
  // El periodo del renglón del libro es el de su estado de cuenta, como lo filtra la lista: el resumen cuenta lo mismo que se recorre.
  const libro = (await trx('finance.bank_movements as bm')
    .leftJoin('finance.bank_statements as st', 'st.id', 'bm.statement_id')
    .whereIn('bm.bank_account_id', ids).whereNull('bm.deleted_at').whereNot('bm.sync_source', 'banco')
    .whereBetween('bm.movement_date', [sumarDias(desde, -3), sumarDias(hasta, 3)])
    .select('bm.id', 'bm.bank_account_id', trx.raw("to_char(bm.movement_date, 'YYYY-MM-DD') as fecha"), 'bm.amount_in', 'bm.amount_out',
      'bm.running_balance', 'st.period as periodo'))
    .map((l: RenglonComparable & { bank_account_id: string; periodo: string | null }) => l);
  const delPeriodo = new Set<string>(libro.filter((l) => l.periodo === periodo).map((l) => l.id));
  const archivos = await trx('finance.bank_statement_files').whereIn('bank_account_id', ids)
    .where('date_from', '<=', hasta).where('date_to', '>=', desde)
    .select('bank_account_id', trx.raw("to_char(date_from, 'YYYY-MM-DD') as desde"), trx.raw("to_char(date_to, 'YYYY-MM-DD') as hasta"));

  const res: DescargaDelPeriodo = { solo: new Map(), trae: new Set(), no_trae: new Set(), resumen: { solo_descarga: 0, no_trae: 0, trae: 0 } };
  const fechaDe = new Map<string, string>(banco.map((r) => [r.id, r.fecha]));
  for (const id of ids) {
    const d = descargaEnMovimientos(
      banco.filter((b) => b.bank_account_id === id), libro.filter((l) => l.bank_account_id === id),
      archivos.filter((a: { bank_account_id: string }) => a.bank_account_id === id), cortes.get(id) ?? null);
    for (const s of d.solo_descarga) if (enMes(fechaDe.get(s.id) ?? '')) res.solo.set(s.id, s.motivo);
    for (const t of d.trae) res.trae.add(t);
    for (const t of d.no_trae) res.no_trae.add(t);
  }
  res.resumen = {
    solo_descarga: res.solo.size,
    trae: Array.from(res.trae).filter((x) => delPeriodo.has(x)).length,
    no_trae: Array.from(res.no_trae).filter((x) => delPeriodo.has(x)).length,
  };
  return res;
}
