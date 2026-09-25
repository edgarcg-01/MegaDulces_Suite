/**
 * [CPU.2] El resolvedor de unidad (ADR-057), y de dónde se lee.
 *
 * El CÓMO (preferir la copia, declarar su edad, sobrevivir a que falte la migración) vive en
 * `@megadulces/platform-core`. Acá vive sólo el CUÁL: qué par de relaciones forman el resolvedor de
 * unidad. Un solo lugar, porque el defecto que esto cierra era justamente tenerlo escrito a mano en
 * cada consumidor — `commercial-analytics` tenía la vista viva clavada en tres lugares con la MV ya
 * poblada al lado.
 *
 * ⚠️ `mv_unit_truth` es `SELECT *` de `v_unit_truth` más `refreshed_at`: una COPIA, no una segunda
 * definición. ADR-057 sigue intacto — hay un solo resolvedor. Lo único que cambia entre las dos es
 * la edad del dato, y por eso esto devuelve la procedencia junto con la relación.
 *
 * Medido el 2026-09-25 contra prod, comparando las dos lado a lado:
 *   llaves (tenant × almacén × producto)                 180,272 = 180,272, sin faltantes ni de más
 *   box_factor · metodo_cajas · base_label · is_weight    CERO diferencias
 *   cja_price                                             32 filas (0.018 %) tras ~6 h de deriva
 * O sea: lo que los consumidores convierten no se mueve; lo que se mueve es el precio de caja. Ése
 * es el argumento por el que la cadencia de refresco importa y no alcanza con declarar la edad.
 */
import { preferMaterialized, type MaterializedChoice } from '@megadulces/platform-core';

export const UNIT_TRUTH_MV = 'analytics.mv_unit_truth';
export const UNIT_TRUTH_VIEW = 'analytics.v_unit_truth';

/** La relación del resolvedor de unidad a consultar, con la edad de lo que devuelve. */
export function unitTruth(
  trx: any,
  logger?: { warn: (m: string) => void },
): Promise<MaterializedChoice> {
  return preferMaterialized(trx, UNIT_TRUTH_MV, UNIT_TRUTH_VIEW, { logger });
}
