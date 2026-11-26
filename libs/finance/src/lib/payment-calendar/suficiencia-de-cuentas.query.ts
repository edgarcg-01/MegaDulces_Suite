import type { Knex } from 'knex';
import { saldosConocidos } from '../bank/estado-de-cuenta/saldo-conocido.query';
import { DIAS_DE_LA_VENTANA, masDias, type CuentaDeOrigen, type EntradaDeSuficiencia, type PagoConCuenta, type SerieEsperada } from './suficiencia-de-cuentas';

/** La vista de `[PGP.209]`: los cargos que el banco cobra solo, por su historia. */
export const VISTA_DE_CARGOS = 'finance.v_recurring_bank_charges';

/** Lo pagado que todavía no liga su salida del banco se busca en los últimos días (medido: 18 pagos, del 17 al 24-nov). */
const DIAS_PAGADO_SIN_DESCARGA = 15;

/**
 * `[PGP.211]` Las series de `[PGP.209]` cuyo cargo ya está PROGRAMADO por su contrato: un movimiento de la serie casa
 * «con contrato» (`[PGP.212]`) con un renglón que tiene su cargo del mes pendiente en el Calendario. Ese cargo ya cuenta
 * en lo que sale de la cuenta (es un pago pendiente con cuenta); contarlo también por su historia sería contarlo dos veces.
 * Sin la vista de PGP.212 o sin las columnas de PGP.211 (migraciones sin aplicar), no hay ninguna.
 */
async function seriesConCargoProgramado(trx: Knex | Knex.Transaction, tenantId: string): Promise<Set<string>> {
  const [hay] = (await trx.raw(`
    SELECT to_regclass('finance.v_automatic_bank_charges') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'finance' AND table_name = 'financial_commitments' AND column_name = 'contract_line_id') AS t`)).rows as { t: boolean }[];
  if (!hay?.t) return new Set();
  const filas = (await trx.raw(`
    SELECT DISTINCT ac.series_key
      FROM finance.v_automatic_bank_charges ac
     WHERE ac.tenant_id = ? AND ac.series_key IS NOT NULL AND ac.reason = 'con_contrato'
       AND EXISTS (SELECT 1 FROM finance.financial_commitments fc
                    WHERE fc.tenant_id = ac.tenant_id AND fc.contract_line_id = ac.contract_line_id AND fc.status IN ('pending', 'partial'))`,
  [tenantId])).rows as { series_key: string }[];
  return new Set(filas.map((f) => f.series_key));
}

/**
 * `[PGP.218]` Lo que `armarSuficiencia` necesita, leído en una transacción con el tenant puesto (la RLS manda):
 *  · las cuentas de origen (banco y factoraje, activas);
 *  · el saldo conocido de cada una al cierre de hoy o antes (`saldosConocidos`, el de Bancos);
 *  · los cargos esperados: las series vigentes de `[PGP.209]` cuyo próximo cargo cae hasta `hasta` (también las
 *    atrasadas). Si la vista no está (su migración sin aplicar), `series = null`: los cargos no se midieron.
 *    Sin las series cuyo cargo ya programó su contrato (`[PGP.211]`): ése cuenta como pago pendiente;
 *  · los pagos pendientes con cuenta de origen cuyo día cae hasta `hasta` (también los atrasados), y los marcados
 *    pagados en los últimos días que todavía no ligan su salida del banco;
 *  · los pendientes SIN cuenta de origen (se elige al preparar): no se pueden contar contra ninguna cuenta.
 * El efectivo no sale de un banco: no entra.
 *
 * `vistaDeCargos` existe para la prueba contra prod: la vista todavía no está ahí y se le pasa su SQL como subconsulta.
 */
export async function leerEntradaDeSuficiencia(
  trx: Knex | Knex.Transaction, tenantId: string, hoy: string, opciones: { vistaDeCargos?: string } = {},
): Promise<EntradaDeSuficiencia> {
  const hasta = masDias(hoy, DIAS_DE_LA_VENTANA);
  const cuentas = (await trx('finance.bank_accounts')
    .where({ tenant_id: tenantId, active: true }).whereIn('kind', ['bank', 'factoraje'])
    .select(trx.raw('id::text AS id'), 'bank', 'account_label', 'alias')
    .orderBy([{ column: 'bank' }, { column: 'account_label' }])) as CuentaDeOrigen[];

  const saldos = await saldosConocidos(trx, cuentas.map((c) => c.id), masDias(hoy, 1));

  let series: SerieEsperada[] | null = null;
  const fuente = opciones.vistaDeCargos ?? VISTA_DE_CARGOS;
  const existe = opciones.vistaDeCargos
    ? true
    : Boolean((await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [VISTA_DE_CARGOS])).rows[0]?.t);
  if (existe) {
    series = ((await trx.raw(`
      SELECT v.bank_account_id::text AS bank_account_id, v.series_key, v.rule, v.concept_head, v.latest_concept,
             to_char(v.next_expected_date, 'YYYY-MM-DD') AS next_expected_date, v.expected_monthly_amount::float AS expected_monthly_amount
        FROM ${fuente} v
       WHERE v.tenant_id = ? AND v.is_active AND v.next_expected_date <= ?`, [tenantId, hasta])).rows as SerieEsperada[]);
    const cubiertas = await seriesConCargoProgramado(trx, tenantId);
    if (cubiertas.size) series = series.filter((s) => !cubiertas.has(s.series_key));
  }

  const pagos = (await trx.raw(`
    SELECT a.id::text AS allocation_id, a.bank_account_id::text AS bank_account_id, to_char(l.lot_date, 'YYYY-MM-DD') AS fecha,
           a.amount_assigned::float AS importe, false AS ejecutado
      FROM finance.payment_allocations a
      JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
     WHERE a.tenant_id = ? AND a.status = 'pending' AND a.bank_account_id IS NOT NULL AND l.lot_date <= ?
       AND coalesce(a.payment_method, '') <> 'efectivo'
    UNION ALL
    SELECT a.id::text, a.bank_account_id::text, to_char((a.executed_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD'),
           coalesce(a.paid_bank_amount, a.amount_assigned)::float, true
      FROM finance.payment_allocations a
     WHERE a.tenant_id = ? AND a.status = 'executed' AND a.bank_account_id IS NOT NULL AND a.paid_bank_movement_id IS NULL
       AND a.executed_at >= (?::date - ${DIAS_PAGADO_SIN_DESCARGA}) AND coalesce(a.payment_method, '') <> 'efectivo'`,
  [tenantId, hasta, tenantId, hoy])).rows as PagoConCuenta[];

  const [sin] = (await trx.raw(`
    SELECT count(*)::int AS pagos, coalesce(sum(a.amount_assigned), 0)::float AS importe
      FROM finance.payment_allocations a
      JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
     WHERE a.tenant_id = ? AND a.status = 'pending' AND a.bank_account_id IS NULL AND l.lot_date <= ?
       AND coalesce(a.payment_method, '') <> 'efectivo'`, [tenantId, hasta])).rows as { pagos: number; importe: number }[];

  return { hoy, hasta, cuentas, saldos, series, pagos, sinCuenta: { pagos: sin?.pagos ?? 0, importe: sin?.importe ?? 0 } };
}
