/**
 * `[PQ.50]` **EL TRASPASO APROBADO QUE NUNCA SALIÓ A KEPLER SE CIERRA SOLO** (D29, firmada por el PM
 * el 2026-11-04).
 *
 * ── Por qué existe, medido en prod el 2026-11-04 ────────────────────────────────────────────
 *
 * La escritura de traspasos desde la Suite está apagada (D28 la enciende; lo hace Edgar). Cada
 * traspaso que Compras aprueba en `/compras/pedido` se queda `approved` sin documento en Kepler:
 * **1,152** así, **867 con más de 7 días ($17.3 M)**, el más viejo del 29-sep. La mesa de
 * `/almacen/autoabasto` ya no los muestra pasado `VENTANA_YA_PEDIDO_DIAS`, y en la bandeja de
 * Compras se ven como vivos para siempre.
 *
 * ── Qué se cierra ───────────────────────────────────────────────────────────────────────────
 *
 * Traspaso (`source_type='branch'`) `approved`, sin folio de Kepler (`kepler_folio`) ni capturado
 * (`oc_folio`), aprobado hace más de `VENTANA_YA_PEDIDO_DIAS`. Pasa a `cancelled` con motivo y
 * `rejected_by` NULL (lo cerró el sistema, no una persona).
 *
 * ⛔ **No se cierra lo que pidió una sucursal** (`requested_by_branch`): la mesa le muestra a la
 * sucursal sus canceladas como «RECHAZADA», y una que Compras aprobó no fue rechazada. Medido el
 * 2026-11-04: 0 casos. Si aparecen, se decide aparte.
 *
 * ⚠️ El motivo **no afirma que el traspaso no ocurrió**: dice que no salió desde la Suite. Si
 * alguien lo hizo a mano en Kepler (`U-D-40`), ese documento es el que la mesa resta; ligarlo es
 * `[PQ.69]`. Cuántos se hicieron a mano: NO MEDIDO.
 *
 * Cada llamada cierra a lo más `limite` (los más viejos primero), para que ninguna escritura sea
 * grande: los 867 de hoy se van en 5 lecturas de la bandeja.
 *
 * Módulo PURO (sin Nest): `database/tests/test-newdb-traspaso-no-ejecutado.js` lo carga con ts-node
 * y corre ESTE MISMO SQL contra una base real.
 */
import type { Knex } from 'knex';
import { VENTANA_YA_PEDIDO_DIAS } from './ya-pedido-sucursal';

/** Cuántos se cierran, a lo más, por llamada. */
export const LIMITE_CIERRE_TRASPASOS = 200;

/** Inicio fijo del motivo: con él se separan los cierres automáticos de los rechazos de una persona. */
export const MOTIVO_TRASPASO_NO_EJECUTADO = 'No salió a Kepler';

/** El universo, compartido por el conteo y el cierre: si uno cambia, el otro también. */
const CANDIDATOS_SQL = `
  SELECT r.id
    FROM commercial.purchase_requisitions r
   WHERE r.tenant_id = ? AND r.estado = 'approved' AND r.source_type = 'branch'
     AND r.kepler_folio IS NULL AND r.oc_folio IS NULL AND NOT r.requested_by_branch
     AND COALESCE(r.approved_at, r.created_at) < ?::timestamptz - make_interval(days => ${VENTANA_YA_PEDIDO_DIAS})`;

/** Cuántos se cerrarían hoy, sin escribir (para la prueba en sólo lectura y para medir antes/después). */
export async function contarTraspasosNoEjecutados(db: Knex | Knex.Transaction, tenantId: string, ahora: Date = new Date()): Promise<number> {
  const r = await db.raw(`SELECT count(*)::int AS n FROM (${CANDIDATOS_SQL}) c`, [tenantId, ahora]);
  return Number(r.rows[0]?.n ?? 0);
}

/** Cierra los más viejos, a lo más `limite`. Devuelve cuántos cerró. */
export async function cerrarTraspasosNoEjecutados(
  db: Knex | Knex.Transaction,
  tenantId: string,
  ahora: Date = new Date(),
  limite: number = LIMITE_CIERRE_TRASPASOS,
): Promise<number> {
  const r = await db.raw(
    `UPDATE commercial.purchase_requisitions q
        SET estado = 'cancelled', rejected_at = ?::timestamptz, rejected_by = NULL, updated_at = now(),
            rejection_reason = '${MOTIVO_TRASPASO_NO_EJECUTADO}: Compras lo aprobó el '
              || to_char(COALESCE(q.approved_at, q.created_at) AT TIME ZONE 'America/Mexico_City', 'DD-MM-YYYY')
              || ' y en ${VENTANA_YA_PEDIDO_DIAS} días no salió desde la Suite (la escritura de traspasos está apagada). '
              || 'Se cerró solo (D29). Si se hizo a mano en Kepler, ese documento es el que cuenta.'
      WHERE q.id IN (SELECT c.id FROM (${CANDIDATOS_SQL}) c
                       JOIN commercial.purchase_requisitions o ON o.id = c.id
                      ORDER BY COALESCE(o.approved_at, o.created_at), o.id
                      LIMIT ?)
        AND q.tenant_id = ? AND q.estado = 'approved'`,
    [ahora, tenantId, ahora, Math.max(0, Math.floor(limite)), tenantId],
  );
  return r.rowCount ?? 0;
}
