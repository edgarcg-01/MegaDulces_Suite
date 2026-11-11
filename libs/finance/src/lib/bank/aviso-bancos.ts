import type { Knex } from 'knex';

/**
 * `[CB.60b]` El canal de Postgres por el que Bancos avisa que cambiaron sus movimientos: una descarga del banco
 * que entró a `bank_movements` (cuenta que ya usa el banco) o una carga del libro. Lo escucha
 * `BankReconPorAvisoService` (CB.53), el mismo oyente que ya escucha a Kepler: así la conciliación corre al
 * llegar el dato de CUALQUIERA de los dos lados, sin reloj.
 *
 * Cierra el hueco que CB.53 dejó declarado: «la carga del estado de cuenta no emite ningún aviso». Hasta hoy
 * eso se tapaba sólo si después llegaba un aviso de Kepler.
 *
 * Canal propio y no `caja_movimientos`: ése lo escuchan también las pantallas de Caja con su propio formato
 * de aviso; un aviso de Bancos ahí las refrescaría por nada.
 */
export const CANAL_BANCOS = 'bancos_movimientos';

export interface AvisoBancos {
  origen: 'descarga' | 'libro';
  /** Periodos `YYYY-MM` que cambiaron. */
  periodos: string[];
  cuenta?: string | null;
}

/**
 * Se llama DENTRO de la transacción que escribió: Postgres entrega el `NOTIFY` sólo si esa transacción se
 * confirma. Un rollback no avisa, y el oyente nunca concilia un dato que no quedó.
 */
export async function avisarBancos(trx: Knex | Knex.Transaction, aviso: AvisoBancos): Promise<void> {
  const payload = JSON.stringify({ ...aviso, periodos: aviso.periodos.slice(0, 24) });
  await trx.raw('select pg_notify(?, ?)', [CANAL_BANCOS, payload]);
}
