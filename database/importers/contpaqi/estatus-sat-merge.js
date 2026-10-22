/**
 * `[LC.19.1]` — Cómo se funde `fiscal.cfdis.estatus_sat` cuando el feed del ADD vuelve a traer
 * un CFDI que ya existe.
 *
 * ⛔ El defecto que esto cierra, medido el 2026-10-21: el UPSERT hacía `estatus_sat =
 * EXCLUDED.estatus_sat`, y el ADD trae `CancelStatus` VACÍO en casi todo (→ `desconocido`). El
 * cron FISCAL.6 le preguntaba al SAT a las 07:30 y dejaba `vigente`; el feed re-sincronizaba el
 * mismo CFDI a las 11:47 y lo regresaba a `desconocido`. Resultado: el 100 % de los recibidos de
 * ago/sep/oct-2026 «sin verificar», y el libro de compras sin poder distinguir una factura
 * cancelada de una vigente. Lo mismo le pasaba a las facturas que NOSOTROS cancelamos.
 *
 * La regla:
 *   1. `cancelado` es ABSORBENTE: un CFDI cancelado no vuelve a estar vigente, venga de donde venga.
 *   2. `desconocido` que llega NO pisa lo que ya se sabía (es «el ADD no preguntó», no un dato).
 *   3. Cualquier otro valor del ADD (`vigente` por «Cancelable…») se toma.
 *
 * @param {string} actual   expresión SQL del valor guardado (p. ej. `fiscal.cfdis.estatus_sat`)
 * @param {string} entrante expresión SQL del valor que llega (p. ej. `EXCLUDED.estatus_sat`)
 * @returns {string} expresión SQL del valor fundido
 */
function mergeEstatusSatSql(actual, entrante) {
  return `CASE WHEN ${actual} = 'cancelado' OR ${entrante} = 'cancelado' THEN 'cancelado'`
    + ` WHEN ${entrante} = 'desconocido' THEN coalesce(${actual}, 'desconocido')`
    + ` ELSE ${entrante} END`;
}

module.exports = { mergeEstatusSatSql };
