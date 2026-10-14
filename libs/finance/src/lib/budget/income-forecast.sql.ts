import type { Knex } from 'knex';
import type { IncomeChannel } from '@megadulces/contracts';

/**
 * `[PU.14]` **El ingreso por día — UNA consulta, dos consumidores.**
 *
 * La usan la pantalla de ingresos (`BudgetIncomeForecastService`) y la propuesta de capacidad del
 * Calendario de Pagos (`BudgetCapacityService`). Estaba a punto de escribirse dos veces; dos copias
 * de «qué es ingreso real» divergen sin avisar (ADR-059 R6), y entonces el calendario autorizaría
 * contra un número distinto del que Finanzas ve en pantalla.
 *
 *  · estimado: `budget.income_forecast_days` de la versión vigente (dato propio).
 *  · real: cobranza de `finance.bank_movements` (`bank` → bancos, `cash` → caja general), sumada en
 *    el momento. `null` después del último día cargado de cada canal; `0` = cargado y no entró nada.
 */

export interface IngresoVersion {
  id: string;
  nombre: string;
  desde: string;
  hasta: string;
  metodo: string;
  parametros: Record<string, unknown>;
  created_at: string;
  created_by: string | null;
}

export interface IngresoDiaRow {
  fecha: string;
  dia_semana: number;
  semana: number;
  semana_anio: number;
  est: Record<IncomeChannel, number | null>;
  real: Record<IncomeChannel, number | null>;
}

const KIND_A_CANAL: Record<string, IncomeChannel> = { bank: 'bancos', cash: 'caja_general' };
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function versionVigente(trx: Knex.Transaction, tenantId: string): Promise<IngresoVersion | null> {
  const [v] = (
    await trx.raw(
      `SELECT id, nombre, to_char(desde, 'YYYY-MM-DD') AS desde, to_char(hasta, 'YYYY-MM-DD') AS hasta,
              metodo, parametros, created_at, created_by
         FROM budget.income_forecasts
        WHERE tenant_id = ? AND es_vigente
        LIMIT 1`,
      [tenantId],
    )
  ).rows;
  if (!v) return null;
  return {
    id: v.id, nombre: v.nombre, desde: v.desde, hasta: v.hasta, metodo: v.metodo,
    parametros: v.parametros ?? {}, created_at: new Date(v.created_at).toISOString(), created_by: v.created_by ?? null,
  };
}

/** Una cuenta frena el corte de su canal si pesa al menos esto de la cobranza de 90 días. */
const PESO_MINIMO_CUENTA = 0.05;

/**
 * Último día cargado, por canal. Es el día MÁS ATRASADO entre las cuentas que pesan (≥ 5 % de la
 * cobranza del canal en 90 días): si una cuenta grande va atrasada, sus días no pueden leerse como
 * «real», porque serían cobranza incompleta. Las cuentas chicas o esporádicas no frenan el corte
 * (medido el 14-oct: STDR 1621 va al 01-oct con 0.0 % y BB 3660 está cerrada desde el 31-ago;
 * con ellas el corte de bancos caería al 31-ago). Si ninguna cuenta pesa, se usa la más adelantada.
 *
 * Tope en AYER: el día de hoy puede venir cargado a medias (14-oct a mediodía: $316k contra $1.6M
 * estimados). Y sin fechas futuras: el libro trae typos de año.
 */
export async function realHasta(trx: Knex.Transaction, tenantId: string): Promise<Record<IncomeChannel, string | null>> {
  const rows = (
    await trx.raw(
      `WITH por_cuenta AS (
         SELECT a.kind, m.bank_account_id,
                max(m.movement_date) AS ult,
                coalesce(sum(m.amount_in) FILTER (
                  WHERE mc.code = 'cobranza' AND m.movement_date >= current_date - 90), 0) AS cob
           FROM finance.bank_movements m
           JOIN finance.bank_accounts a ON a.id = m.bank_account_id
           LEFT JOIN finance.movement_categories mc ON mc.id = m.category_id
          WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND a.kind IN ('bank', 'cash')
            AND m.movement_date < current_date
          GROUP BY 1, 2
       ), pesos AS (
         SELECT *, cob / nullif(sum(cob) OVER (PARTITION BY kind), 0) AS peso FROM por_cuenta
       )
       SELECT kind,
              to_char(coalesce(min(ult) FILTER (WHERE peso >= ?), max(ult)), 'YYYY-MM-DD') AS hasta
         FROM pesos
        GROUP BY kind`,
      [tenantId, PESO_MINIMO_CUENTA],
    )
  ).rows as Array<Record<string, unknown>>;
  const out: Record<IncomeChannel, string | null> = { bancos: null, caja_general: null };
  for (const r of rows) {
    const canal = KIND_A_CANAL[String(r['kind'])];
    if (canal) out[canal] = (r['hasta'] as string | null) ?? null;
  }
  return out;
}

/** Un renglón por día de `[desde, hasta]` con el estimado de `forecastId` (o ninguno) y lo real. */
export async function ingresoPorDia(
  trx: Knex.Transaction,
  tenantId: string,
  forecastId: string | null,
  desde: string,
  hasta: string,
  tope: Record<IncomeChannel, string | null>,
): Promise<IngresoDiaRow[]> {
  const filas = (
    await trx.raw(
      `WITH d AS (
         SELECT g::date AS fecha FROM generate_series(?::date, ?::date, interval '1 day') g
       ), est AS (
         SELECT fecha, canal, monto
           FROM budget.income_forecast_days
          WHERE tenant_id = ? AND forecast_id = ?::uuid
       ), real AS (
         SELECT m.movement_date AS fecha, a.kind, sum(m.amount_in) AS monto
           FROM finance.bank_movements m
           JOIN finance.bank_accounts a ON a.id = m.bank_account_id
           JOIN finance.movement_categories mc ON mc.id = m.category_id
          WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND mc.code = 'cobranza'
            AND a.kind IN ('bank', 'cash')
            AND m.movement_date BETWEEN ?::date AND ?::date
          GROUP BY 1, 2
       )
       SELECT to_char(d.fecha, 'YYYY-MM-DD') AS fecha,
              extract(isodow FROM d.fecha)::int AS dia_semana,
              extract(week FROM d.fecha)::int AS semana,
              extract(isoyear FROM d.fecha)::int AS semana_anio,
              eb.monto AS est_bancos, ec.monto AS est_caja,
              rb.monto AS real_bancos, rc.monto AS real_caja
         FROM d
         LEFT JOIN est eb ON eb.fecha = d.fecha AND eb.canal = 'bancos'
         LEFT JOIN est ec ON ec.fecha = d.fecha AND ec.canal = 'caja_general'
         LEFT JOIN real rb ON rb.fecha = d.fecha AND rb.kind = 'bank'
         LEFT JOIN real rc ON rc.fecha = d.fecha AND rc.kind = 'cash'
        ORDER BY d.fecha`,
      [desde, hasta, tenantId, forecastId, tenantId, desde, hasta],
    )
  ).rows as Array<Record<string, unknown>>;

  return filas.map((r) => {
    const fecha = String(r['fecha']);
    // Sin movimientos ese día pero DENTRO de lo cargado = entró cero. Después de lo cargado = sin dato.
    const real = (canal: IncomeChannel, valor: unknown): number | null => {
      const t = tope[canal];
      if (!t || fecha > t) return null;
      return num(valor) ?? 0;
    };
    return {
      fecha,
      dia_semana: Number(r['dia_semana']),
      semana: Number(r['semana']),
      semana_anio: Number(r['semana_anio']),
      est: { bancos: num(r['est_bancos']), caja_general: num(r['est_caja']) },
      real: { bancos: real('bancos', r['real_bancos']), caja_general: real('caja_general', r['real_caja']) },
    };
  });
}

/** Los días inhábiles bancarios que declara la versión (si no declara, ninguno). */
export function inhabilesDe(v: IngresoVersion | null): string[] {
  const x = (v?.parametros as { inhabiles?: unknown } | undefined)?.inhabiles;
  return Array.isArray(x) ? x.filter((d): d is string => typeof d === 'string') : [];
}
