/**
 * `[AUD-DAT.22]` — **La ventana de fechas válidas del hecho de venta, declarada UNA vez.**
 *
 * ── DE DÓNDE SALE ─────────────────────────────────────────────────────────────────────────
 * `analytics.sales_daily` tiene TRES rollups que corren en el mismo carril nocturno:
 *
 *      analytics.sales_monthly            <- import-sales-monthly.js
 *      analytics.sales_boxes_monthly      <- import-sales-boxes-monthly.js
 *      analytics.sales_by_vendor_monthly  <- import-sales-by-vendor-monthly.js
 *
 * Y sólo el PRIMERO declaraba un piso de fechas (`const FLOOR = '2024-01-01'`). Medido en
 * producción el 2026-10-02:
 *
 *      objeto                      buckets imposibles
 *      sales_monthly               NINGUNO
 *      sales_boxes_monthly         2000-01 ($238,071) · 2014-06 ($5,737) · 2020-07 · 2020-10 · 2026-12
 *      sales_by_vendor_monthly     los mismos cinco
 *
 * ⭐ El mismo hecho, el mismo carril, tres rollups, UN solo guardia. Cualquier gráfica de
 * "últimos 12 meses" sobre los dos de abajo pinta una barra de diciembre-2026 que todavía no
 * existe, y cualquier listado de meses arranca en el año 2000.
 *
 * ── QUÉ SON ESAS FILAS (y por qué NO se borran del hecho base) ────────────────────────────
 * Las 230 filas de `sales_daily` fuera de ventana son **todas de Wincaja** (`wincaja_credito`,
 * `wincaja_mostrador`, `wincaja_ruta`). No son un defecto del importer: son tickets REALES con
 * la fecha corrompida en el punto de venta — el año 2000 es la firma de un reloj reseteado.
 * Borrarlas perdería venta que ocurrió; publicarlas en su mes falso miente sobre cuándo.
 * Por eso el hecho base las CONSERVA y declara (`[AUD-DAT.2]`, CHECK NOT VALID que frena a las
 * nuevas), y son los ROLLUPS los que no deben publicarlas en un bucket.
 *
 * ── POR QUÉ ACÁ Y NO UNA CONSTANTE POR IMPORTER ──────────────────────────────────────────
 * Porque ya había dos declaraciones del mismo número (la constante del importer y el CHECK de
 * la tabla) y agregar una tercera y una cuarta es cómo se vuelven cinco que no coinciden.
 * ⚠️ Este módulo NO inventa un número nuevo: es el MISMO `2024-01-01` que ya vive en
 * `sales_daily_sale_date_piso_check`. Si alguno cambia, `test-newdb-sales-rollup-window.js`
 * se pone rojo porque los compara entre sí.
 */

/** Piso de fechas válidas. El MISMO valor que el CHECK `sales_daily_sale_date_piso_check`. */
const PISO = '2024-01-01';

/**
 * Fragmento SQL que acota una columna de fecha a la ventana válida.
 * ⚠️ El techo es `current_date` y NO puede vivir en un CHECK (no es IMMUTABLE): por eso la
 * ventana se aplica en la CONSULTA del rollup, no sólo en la restricción de la tabla.
 */
const guardaFecha = (col) => `${col} >= DATE '${PISO}' AND ${col} <= current_date`;

/** El mismo filtro, en forma de bucket 'YYYY-MM', para los rollups que agrupan por texto. */
const guardaBucket = (col) => `${col} >= '${PISO.slice(0, 7)}' AND ${col} <= to_char(current_date, 'YYYY-MM')`;

module.exports = { PISO, guardaFecha, guardaBucket };
