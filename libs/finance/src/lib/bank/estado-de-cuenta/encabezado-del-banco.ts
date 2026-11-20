import type { Knex } from 'knex';
import { aperturaDelDia, cierreDelDia, type RenglonDelLibro } from './saldo-del-libro';

/**
 * `[CB.75]` **El encabezado del estado de cuenta de una cuenta que ya usa el banco, derivado de sus movimientos.**
 *
 * ⛔ El hueco (auditoría de `/finanzas/bancos`, 2026-11-17): Cuentas (cuadre de saldos), Cuadre 3 vías, la comparación
 * contra ContPAQi y la Conciliación leen el saldo inicial, el final y los totales del ENCABEZADO
 * (`finance.bank_statements`), no la suma de movimientos. La carga del libro los llena con lo que trae el Excel; la
 * descarga del banco (`alimentarDesdeElBanco`) creaba el encabezado del periodo VACÍO. Al pasar una cuenta al banco,
 * esas cuatro vistas iban a mostrar cero —o el parcial del libro— como si fuera el saldo: lo no medido dibujado como
 * cero. Y una carga del libro posterior lo volvía a pisar con los totales del Excel.
 *
 * Ahora, para una cuenta que usa el banco, el encabezado de cada periodo se DERIVA de sus movimientos vivos:
 *  - totales: la suma de abonos y cargos;
 *  - saldo inicial: la apertura de los DOS primeros días con movimientos, juntos (la cadena de saldos,
 *    `aperturaDelDia`). En el mes en que la cuenta pasó al banco ese primer día es del libro, y abre en el saldo del
 *    libro: está bien, es el mismo mes;
 *  - saldo final: el cierre del último día (`cierreDelDia`), que en una cuenta del banco es el saldo del banco.
 * Así «inicial + abonos − cargos = final» vuelve a ser una prueba y no una tautología: el final lo pone el banco.
 *
 * Si la cadena de alguno de los dos días no se puede afirmar, el encabezado queda en «sin saldo» (inicial y final en
 * cero, que `balances` declara `sin_saldo`) y `medido: false`: nunca un saldo inventado.
 * `[BFU.3.4]` Por qué dos días y no uno: BBVA aplica a veces un cargo fechado al día siguiente ANTES que los abonos del
 * día (una cuenta BBVA: un cargo fechado el 03-nov va primero en la cadena del 02-nov). Con un solo día la
 * apertura salía DESPUÉS de ese cargo y Cuentas marcaba «no cierra» por su importe exacto.
 * Con los dos días, el saldo que dejó ese cargo lo produce un renglón del conjunto y la apertura vuelve a ser única.
 * ⚠️ Límite que queda: el mismo cargo adelantado en el ÚLTIMO día del mes sale en el cierre (es real y se ve).
 */
export interface EncabezadoDelBanco {
  periodo: string;
  opening_balance: number;
  closing_balance: number;
  total_in: number;
  total_out: number;
  /** `false` = la apertura o el cierre no se pudieron afirmar: el encabezado queda «sin saldo». */
  medido: boolean;
}

export function armarEncabezado(p: {
  periodo: string;
  primerDia: readonly RenglonDelLibro[];
  ultimoDia: readonly RenglonDelLibro[];
  totalIn: number | string;
  totalOut: number | string;
}): EncabezadoDelBanco {
  const total_in = Math.round(Number(p.totalIn || 0) * 100) / 100;
  const total_out = Math.round(Number(p.totalOut || 0) * 100) / 100;
  const apertura = p.primerDia.length ? aperturaDelDia(p.primerDia) : null;
  const cierre = p.ultimoDia.length ? cierreDelDia(p.ultimoDia) : null;
  if (apertura === null || cierre === null) {
    return { periodo: p.periodo, opening_balance: 0, closing_balance: 0, total_in, total_out, medido: false };
  }
  return { periodo: p.periodo, opening_balance: apertura, closing_balance: cierre, total_in, total_out, medido: true };
}

const finDe = (periodo: string): string => {
  const [a, m] = periodo.split('-').map(Number);
  return m >= 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
};

/**
 * Re-deriva el encabezado de cada periodo de una cuenta que usa el banco. Va dentro de la transacción que movió los
 * movimientos (la descarga que entra, el paso al banco, la carga del libro), para que nadie lea un encabezado viejo.
 */
export async function refrescarEncabezadosDelBanco(
  trx: Knex.Transaction, cuentaId: string, periodos: readonly string[],
): Promise<EncabezadoDelBanco[]> {
  const out: EncabezadoDelBanco[] = [];
  for (const periodo of Array.from(new Set(periodos)).sort()) {
    const st = await trx('finance.bank_statements').where({ bank_account_id: cuentaId, period: periodo }).first('id');
    if (!st) continue;
    const vivos = () => trx('finance.bank_movements').where({ statement_id: (st as { id: string }).id }).whereNull('deleted_at')
      .where('movement_date', '>=', `${periodo}-01`).where('movement_date', '<', finDe(periodo));
    const tot = await vivos().first(trx.raw('coalesce(sum(amount_in), 0) as tin'), trx.raw('coalesce(sum(amount_out), 0) as tout'),
      trx.raw("to_char(min(movement_date), 'YYYY-MM-DD') as primero"), trx.raw("to_char(max(movement_date), 'YYYY-MM-DD') as ultimo")) as
      { tin: string; tout: string; primero: string | null; ultimo: string | null } | undefined;
    const delDia = async (dia: string | null | undefined): Promise<RenglonDelLibro[]> => (dia
      ? await vivos().where('movement_date', dia).select('amount_in', 'amount_out', 'running_balance') : []);
    const segundo = tot?.primero
      ? ((await vivos().where('movement_date', '>', tot.primero).first(trx.raw("to_char(min(movement_date), 'YYYY-MM-DD') as d"))) as { d: string | null } | undefined)?.d ?? null
      : null;
    const enc = armarEncabezado({
      periodo, primerDia: [...await delDia(tot?.primero), ...await delDia(segundo)], ultimoDia: await delDia(tot?.ultimo),
      totalIn: tot?.tin ?? 0, totalOut: tot?.tout ?? 0,
    });
    await trx('finance.bank_statements').where({ id: (st as { id: string }).id }).update({
      opening_balance: enc.opening_balance, closing_balance: enc.closing_balance,
      total_in: enc.total_in, total_out: enc.total_out, updated_at: trx.fn.now(),
    });
    out.push(enc);
  }
  return out;
}
