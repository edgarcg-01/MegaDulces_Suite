import type { Knex } from 'knex';
import { SUCURSAL_CAJA_GENERAL } from '@megadulces/contracts';

export interface JornadaSinCorte { fecha: string; movimientos: number }

/**
 * ⛔⛔ `[CGP-L.12]` **LA JORNADA DE UN MOVIMIENTO DEL LIBRO ES EL DÍA EN QUE SE MOVIÓ EL EFECTIVO.**
 *
 * Decisión de Edgar, 2026-10-15: *«el día en que se movió el efectivo»*. **No** `cash_ledger.fecha`,
 * que es la fecha del DOCUMENTO de Kepler y llega con una mediana de **3 días** de rezago
 * (`[CG.82]`: 2 de 5 movimientos vivos en prod tenían el papel de otro día, uno fechado 10-dic y
 * registrado el 28-sep).
 *
 * ⭐ **Por qué importa, y no es una preferencia:** el esperado del cajón se arma con las dos piernas
 * del cajero, y **se cancelan contra su movimiento del libro**:
 *
 *     gasto con dispensación -> dispensación +2,000 · gasto −2,000 = 0
 *     nómina $32,237 con dispensaciones $32,220      = −$17 (la morralla la puso el cajón)
 *
 * Esa cancelación **exige que las dos piernas caigan en la MISMA jornada**. CAOS se agrupa por
 * `accounting_date` (el día físico); si el libro se agrupa por el día del papel, la dispensación cae
 * en un corte y su gasto en otro: el primero pide contar efectivo que ya se gastó (**faltante
 * inventado**) y el segundo sobra por el mismo monto. Es el mismo defecto que `[CG.160]` corrigió en
 * el eje PLAZA, acá en el eje TIEMPO.
 *
 * ⚠️ **`created_at` es cuándo se TECLEÓ**, que coincide con el día del efectivo cuando la captura es
 * del mismo día. El libro no tiene una columna para «el día del efectivo»; una captura tardía vuelve
 * a separar las piernas. Deuda declarada: una columna propia, por omisión la de captura.
 *
 * ⛔ Una sola definición, y la comparten los TRES lectores (el universo del corte, los sueltos de
 * otros días y las jornadas sin corte). Tres copias de esta regla divergen — que es exactamente cómo
 * nació este defecto: `arqueoDelDia` ya usaba `created_at` y el corte se quedó en `fecha`.
 */
export const JORNADA_LIBRO = `(created_at AT TIME ZONE 'America/Mexico_City')::date`;

/**
 * El mismo día, como **rango sobre la columna** — la forma que conserva el índice.
 *
 * ⚠️ Nunca `(created_at AT TIME ZONE …)::date = ?`: envolver la columna en una expresión la saca de
 * cualquier índice. Es el defecto que en `[LC.9]` convirtió un `to_char(fecha)` en un seq scan de
 * 167k filas. Acá el predicado se escribe al revés: se convierte el DÍA, no la columna.
 */
export function enJornadaLibro<Q extends Knex.QueryBuilder>(q: Q, dia: string): Q {
  return q
    .whereRaw(`created_at >= (?::date) AT TIME ZONE 'America/Mexico_City'`, [dia])
    .whereRaw(`created_at <  ((?::date) + 1) AT TIME ZONE 'America/Mexico_City'`, [dia]) as Q;
}

/**
 * `[CGP-L.4]` y `[CGP-L.10]` — Las jornadas del cajón con movimientos vivos y SIN corte.
 *
 * Una sola consulta para dos lectores, a propósito: el sensor (que avisa) y la pantalla (que ofrece
 * abrir el corte atrasado). Dos copias de esta regla divergen, y entonces la campana avisa de un día
 * que la pantalla no ofrece cerrar — o al revés.
 *
 *  · Desde el PRIMER corte: antes de eso los días son historia de Control, no jornadas del libro.
 *  · `terminadaHaceH`: cuántas horas tiene que llevar terminada la jornada para contar. El sensor
 *    pide 26 (para no avisar cada madrugada); la pantalla pide 0 (todo día que ya pasó).
 *  · Los movimientos de OTRAS plazas cuentan: el cajón de la 00 las paga (`aplicarAlcanceCaja`).
 *
 * ⚠️ RLS: quien llama tiene que haber fijado `app.tenant_id` en esta transacción.
 */
export async function jornadasSinCorte(
  trx: Knex | Knex.Transaction, tenantId: string, terminadaHaceH: number,
): Promise<{ inicio: string | null; jornadas: JornadaSinCorte[] }> {
  const inicio = await trx.raw(
    `SELECT to_char(min(fecha), 'YYYY-MM-DD') AS d FROM finance.cash_ledger_cuts WHERE tenant_id = ?`, [tenantId]);
  const r = await trx.raw(`
    WITH inicio AS (SELECT min(fecha) AS d FROM finance.cash_ledger_cuts WHERE tenant_id = ?)
    SELECT to_char(j.dia, 'YYYY-MM-DD') AS fecha, count(*)::int AS movimientos
      FROM (SELECT ${JORNADA_LIBRO} AS dia, tenant_id, deleted_at, estado
              FROM finance.cash_ledger) j, inicio
     WHERE j.tenant_id = ? AND j.deleted_at IS NULL AND j.estado <> 'cancelado'
       AND inicio.d IS NOT NULL AND j.dia >= inicio.d
       AND (j.dia + 1)::timestamp
           < (now() AT TIME ZONE 'America/Mexico_City') - make_interval(hours => ?)
       AND NOT EXISTS (
         SELECT 1 FROM finance.cash_ledger_cuts c
          WHERE c.tenant_id = j.tenant_id AND c.sucursal = ? AND c.fecha = j.dia)
     GROUP BY j.dia
     ORDER BY j.dia`, [tenantId, tenantId, terminadaHaceH, SUCURSAL_CAJA_GENERAL]);
  return {
    inicio: inicio.rows[0]?.d ?? null,
    jornadas: r.rows.map((x: { fecha: string; movimientos: number }) => ({ fecha: x.fecha, movimientos: Number(x.movimientos) })),
  };
}

/** La fecha de hoy en México, la de la BASE: el reloj del servidor de la app puede estar en otra zona. */
export async function hoyMx(trx: Knex | Knex.Transaction): Promise<string> {
  const r = await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`);
  return r.rows[0].d as string;
}
