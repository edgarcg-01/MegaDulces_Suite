import type { Knex } from 'knex';

/** El cajón: la Caja General es UNA y su corte es el de la 00 (`[CG.98]`). */
export const SUCURSAL_DEL_CAJERO = '00';

export interface JornadaSinCorte { fecha: string; movimientos: number }

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
    SELECT to_char(l.fecha, 'YYYY-MM-DD') AS fecha, count(*)::int AS movimientos
      FROM finance.cash_ledger l, inicio
     WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
       AND inicio.d IS NOT NULL AND l.fecha >= inicio.d
       AND (l.fecha + 1)::timestamp
           < (now() AT TIME ZONE 'America/Mexico_City') - make_interval(hours => ?)
       AND NOT EXISTS (
         SELECT 1 FROM finance.cash_ledger_cuts c
          WHERE c.tenant_id = l.tenant_id AND c.sucursal = ? AND c.fecha = l.fecha)
     GROUP BY l.fecha
     ORDER BY l.fecha`, [tenantId, tenantId, terminadaHaceH, SUCURSAL_DEL_CAJERO]);
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
