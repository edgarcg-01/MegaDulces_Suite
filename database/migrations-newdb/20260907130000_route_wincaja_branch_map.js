/**
 * U.6 — las 7 rutas que SÓLO vive Wincaja quedan mapeadas a su sucursal, y el resolvedor de
 * unidad empieza a cubrirlas.
 *
 * ── El hueco, medido ───────────────────────────────────────────────────────────────────────
 * `analytics.v_unit_truth` (y su base `v_warehouse_box_factor`) sólo arma filas para almacenes
 * con `kepler_code` o `wincaja_source_branch`. Los 13 almacenes `RUTA-*` no tienen ninguno de los
 * dos, asi que **no tienen fila**: $60,148,173 de venta 365d (9.4% del total) sin divisor. Y lo
 * peor de una fila ausente es como se lee: en un LEFT JOIN sale NULL, y un `COALESCE(medible,
 * true)` la cuenta como medible. Mi propio test de cobertura cayo en eso y reportaba 98.2%.
 *
 * ── Que resulto NO ser el problema ─────────────────────────────────────────────────────────
 * No falta el dato. `wincaja.articulos` tiene las 13 sucursales de ruta -- '21','22','23','26',
 * '27','28','321','322','501'..'505' -- con ~15,330 articulos cada una y ~13,100 con
 * `factor_venta > 1`. Lo que faltaba era el MAPEO: la columna `wincaja_source_branch` en las filas
 * `RUTA-*` de `commercial.warehouses`. El pareo es directo y ya lo usa
 * `analytics.mv_wincaja_sales_daily`, que emite (source_branch '501', warehouse_code 'RUTA-501').
 *
 * ── Por que SOLO 7 de las 13 ⚠️ ────────────────────────────────────────────────────────────
 * Las 6 rutas de La Piedad (RUTA-21, 22, 23, 26, 27, 28) **cambiaron de ERP**: Wincaja hasta el
 * 2026-06-26 y Kepler desde el 2026-06-29, que emite sus sub-almacenes como '01-00N' y el importer
 * traduce a RUTA-2N (ROUTE_MAP en import-sales-fact.js). Medido en el canal: `wincaja_ruta` termina
 * el 26-jun y `credito`/`tienda` arrancan el 29-jun, sin solape.
 *
 * Eso significa que **su divisor depende de la FECHA**, y una columna estatica no puede expresarlo:
 *   · hasta 2026-06-26 la cantidad viene en unidad de venta de Wincaja (el paquete en multipack)
 *   · desde 2026-06-29 viene en la unidad BASE de Kepler
 * Confirmado por el precio realizado (180d, ya post-cutover): las 6 son 87-95% peldano BASE,
 * mientras las 7 de Wincaja traen 19-31% en PAQUETE. Son poblaciones distintas.
 *
 * Ponerles `wincaja_source_branch` les daria el divisor de Wincaja sobre datos que hoy vienen en
 * base -- exactamente el error de peldano que esta fase existe para cerrar. Se dejan SIN mapear y
 * se declaran (ver `analytics.v_unit_truth_coverage`), en vez de elegirles un divisor a ciegas.
 *
 * Las 7 que si se mapean son Wincaja puro de punta a punta ($33.6M): 321, 322, 501, 502, 503, 504,
 * 505. Todas dejaron de vender entre el 2026-06-01 y el 2026-08-11, asi que esto no cambia ninguna
 * cifra viva -- ordena el historico, que es donde se leen.
 *
 * Idempotente: sólo escribe donde la columna está NULL, y sólo si la sucursal existe de verdad en
 * `wincaja.articulos` (si el replica todavía no la trajo, no se inventa el mapeo).
 *
 * @param { import("knex").Knex } knex
 */
const RUTAS_WINCAJA_PURO = [
  ['RUTA-321', '321'], ['RUTA-322', '322'],
  ['RUTA-501', '501'], ['RUTA-502', '502'], ['RUTA-503', '503'],
  ['RUTA-504', '504'], ['RUTA-505', '505'],
];

exports.up = async function up(knex) {
  for (const [code, branch] of RUTAS_WINCAJA_PURO) {
    const r = await knex.raw(
      `UPDATE commercial.warehouses w
          SET wincaja_source_branch = ?, updated_at = now()
        WHERE w.code = ?
          AND w.wincaja_source_branch IS NULL
          AND w.kepler_code IS NULL
          AND w.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM wincaja.articulos a
                       WHERE a.tenant_id = w.tenant_id
                         AND a.source_branch = ?
                         AND a.source_dataset = 'actual')`,
      [branch, code, branch],
    );
    if (r.rowCount) console.log(`  ${code} -> sucursal Wincaja ${branch}`);
  }
};

exports.down = async function down(knex) {
  for (const [code, branch] of RUTAS_WINCAJA_PURO) {
    await knex.raw(
      `UPDATE commercial.warehouses SET wincaja_source_branch = NULL, updated_at = now()
        WHERE code = ? AND wincaja_source_branch = ?`, [code, branch],
    );
  }
};
