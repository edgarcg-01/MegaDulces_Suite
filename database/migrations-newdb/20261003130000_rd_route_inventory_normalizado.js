'use strict';
/**
 * `[RD.14]` — **La identidad de la ruta sale de la tabla principal, y el ledger se materializa.**
 *
 * Corrige dos defectos de `20261003120000`, los dos señalados por Edgar y los dos medidos:
 *
 * ── 1. La lista de rutas estaba A MANO ──────────────────────────────────────────────────────
 * `v_rd_route_identity` llevaba las 11 rutas en un `VALUES` embebido: route_no, destino de
 * Kepler, almacén del ERP, sucursal emisora y plaza, todo tecleado. Eso es exactamente la
 * familia de **constantes duplicadas a mano** que ADR-056 cuenta entre las deudas del repo —
 * una ruta nueva (o una que cambia de plaza) habría que recordar venir a editarla acá, y nada
 * avisaría si no se hace.
 *
 * ⭐ **La tabla donde eso vive ya existía, con su PK y su FK, y estaba VACÍA en las columnas que
 * importan.** Medido antes de inventar nada:
 *
 *   · `commercial.warehouses` — PK `id`. Trae las 13 rutas como `kind='truck'`
 *     (`RUTA-21`…`RUTA-28`, `RUTA-321/322`, `RUTA-501`…`RUTA-505`), **activas**, y dos columnas
 *     ya canónicas para esto: `kepler_code` (el código del ERP — poblado en las 9 sucursales:
 *     `01`→`01`, `06`→`06`) y `source_warehouse_id` (FK al almacén que la surte). En las rutas
 *     las dos estaban **NULL**.
 *   · `analytics.transfer_dest_map` — ya tiene los **11** destinos de ruta de Kepler con su
 *     `dest_label` (que trae hasta el nombre del chofer: *"R.D. 23 PH Hurtado Orozco Joaquin"*)
 *     y una columna **`warehouse_id`, FK a `commercial.warehouses.id`**… en NULL para las 11.
 *     La consume `/almacen/movimientos` desde antes que esta fase existiera.
 *
 * ⇒ Esta migración **puebla esas tres columnas** y reescribe la vista como un JOIN. Cero
 * `VALUES`. La membresía pasa a ser **dato**: una ruta aparece cuando tiene fila de almacén,
 * destino mapeado con su FK, y almacén de origen. Morelia `321`/`322` caen solas —no tienen
 * destino de embarque en Kepler— en vez de estar excluidas por una lista.
 *
 * ⚠️ `route_no` se **deriva** del código canónico (`RUTA-23` → `23`), no se teclea: es una
 * transformación determinista de la PK, no una segunda fuente. El candado lo verifica contra
 * `analytics.route_push_lines`, que es quien usa ese valor.
 *
 * ── 2. La pantalla tardaba 1.8 s y el listón son 0.5 s ───────────────────────────────────────
 * Medido contra prod con la consulta **del servicio** (no una parecida — ése fue el error de la
 * primera versión, que midió el resumen del ledger y concluyó 664 ms):
 *
 *     routeInventory() sobre la vista ..... 1,822 / 1,748 / 1,775 ms   ·  1,109,446 buffers
 *
 * El costo está en el `Append` que vuelve a derivar `kdm1 ⋈ kdm2` entero en cada carga: 108,081
 * filas que colapsan a 8,509. **Materializar es legítimo cuando el costo está medido** (regla
 * #1 del proyecto: derivar salvo que el costo lo justifique) y acá lo está.
 *
 * `analytics.mv_rd_route_ledger` es una **copia por costo** de la vista — `SELECT *`, a
 * propósito: si alguien le agrega una columna a la vista, se recrea y listo; no hay una segunda
 * lógica que pueda divergir. Diminuta (~108k filas), con `UNIQUE` sobre el grano para admitir
 * `REFRESH CONCURRENTLY` sin bloquear lecturas.
 *
 * ⛔ **La vista NO se toca ni se retira**: es la que da el dato al momento y la que el candado
 * usa como árbitro de paridad contra la matvista. Materializar sin dejar con qué contrastar es
 * quedarse sin forma de saber que la copia se quedó vieja.
 *
 * @param { import("knex").Knex } knex
 */

const IDENT = 'analytics.v_rd_route_identity';
const LEDGER = 'analytics.v_rd_route_ledger';
const MV = 'analytics.mv_rd_route_ledger';

/**
 * El mapeo ruta → almacén del ERP. Son los únicos datos que esta migración **siembra**, y no
 * son una constante de negocio: es el resultado de una MEDICIÓN —la venta diaria de cada
 * almacén `01-00N` coincide al centavo con la del carril push de su ruta (ver §2.3 del plan)—
 * que a partir de acá vive en la columna canónica `commercial.warehouses.kepler_code`.
 * Las de Canindo no tienen almacén propio en Kepler: van a NULL, declarado, no inventado.
 */
const ERP = {
  'RUTA-21': '01-001', 'RUTA-22': '01-002', 'RUTA-23': '01-003',
  'RUTA-26': '01-004', 'RUTA-27': '01-005', 'RUTA-28': '01-006',
};
/** Quién surte a quién. `RUTA-321/322` quedan fuera: no tienen embarque documentado. */
const ORIGEN = {
  'RUTA-21': '01', 'RUTA-22': '01', 'RUTA-23': '01',
  'RUTA-26': '01', 'RUTA-27': '01', 'RUTA-28': '01',
  'RUTA-501': '06', 'RUTA-502': '06', 'RUTA-503': '06',
  'RUTA-504': '06', 'RUTA-505': '06',
};

exports.up = async function up(knex) {
  // ── 1. El código del ERP, en su columna canónica ──────────────────────────────────────────
  for (const [code, kepler] of Object.entries(ERP)) {
    await knex.raw(
      `UPDATE commercial.warehouses SET kepler_code = ?, updated_at = now()
        WHERE code = ? AND kind = 'truck' AND deleted_at IS NULL
          AND kepler_code IS DISTINCT FROM ?`, [kepler, code, kepler]);
  }

  // ── 2. Quién la surte: FK al almacén madre ────────────────────────────────────────────────
  for (const [code, madre] of Object.entries(ORIGEN)) {
    await knex.raw(
      `UPDATE commercial.warehouses w
          SET source_warehouse_id = m.id, updated_at = now()
         FROM commercial.warehouses m
        WHERE w.code = ? AND w.kind = 'truck' AND w.deleted_at IS NULL
          AND m.tenant_id = w.tenant_id AND m.code = ? AND m.deleted_at IS NULL
          AND w.source_warehouse_id IS DISTINCT FROM m.id`, [code, madre]);
  }

  // ── 3. El destino de Kepler, atado a la ruta por FK ───────────────────────────────────────
  // `RUTA 23` / `RD 501` son los dos vocabularios que usa Kepler; el puente al almacén es esta
  // FK, no una regla de texto en una vista.
  await knex.raw(`
    UPDATE analytics.transfer_dest_map d
       SET warehouse_id = w.id, updated_at = now()
      FROM commercial.warehouses w
     WHERE w.tenant_id = d.tenant_id AND w.kind = 'truck' AND w.deleted_at IS NULL
       AND d.dest_code ~ '^(RUTA|RD) [0-9]+$'
       AND split_part(w.code, '-', 2) = split_part(d.dest_code, ' ', 2)
       AND d.warehouse_id IS DISTINCT FROM w.id`);

  // ── 4. La identidad, ahora derivada de la tabla principal ─────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${IDENT} AS
    SELECT w.tenant_id,
           split_part(w.code, '-', 2)          AS route_no,
           d.dest_code                         AS destino,
           w.kepler_code                       AS almacen_erp,
           m.kepler_code                       AS suc_emisor,
           m.name::text                        AS plaza,
           c.carga_desde,
           w.id                                AS warehouse_id
      FROM commercial.warehouses w
      JOIN analytics.transfer_dest_map d
        ON d.tenant_id = w.tenant_id AND d.warehouse_id = w.id
      JOIN commercial.warehouses m
        ON m.id = w.source_warehouse_id AND m.deleted_at IS NULL
      CROSS JOIN LATERAL (
           SELECT min(h.c9)::date AS carga_desde
             FROM kepler_ods.kdm1 h
            WHERE h.sucursal = m.kepler_code
              AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
              AND h.c10 = d.dest_code
              AND h.c9 > '2020-01-01'
      ) c
     WHERE w.kind = 'truck' AND w.deleted_at IS NULL AND c.carga_desde IS NOT NULL
  `);
  await knex.raw(`ALTER VIEW ${IDENT} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${IDENT} TO app_runtime`);

  // ── 5. La copia por costo del ledger ──────────────────────────────────────────────────────
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [MV]);
  if (!(existe.rows[0] && existe.rows[0].t)) {
    await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT * FROM ${LEDGER}`);
    // UNIQUE sobre el grano = requisito de REFRESH CONCURRENTLY (y aserción de que el grano
    // es único: si algún día el UNION duplicara, el REFRESH falla en vez de publicar doble).
    await knex.raw(`CREATE UNIQUE INDEX ux_mv_rd_route_ledger
      ON ${MV} (tenant_id, route_no, business_date, clase, sku, unidad)`);
    await knex.raw(`CREATE INDEX ix_mv_rd_route_ledger_rango
      ON ${MV} (tenant_id, business_date) INCLUDE (route_no, clase)`);
    await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
    await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
      'RD.14 - copia POR COSTO de analytics.v_rd_route_ledger (SELECT *, para que no pueda divergir). La vista viva sigue siendo el arbitro de paridad. Medido: la consulta del servicio sobre la vista tardaba 1,775 ms / 1.1M buffers contra un liston de 500 ms.'`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  // La identidad vuelve a su forma anterior la recrea la migración 20261003120000; acá no se
  // reconstruye a mano (sería una tercera copia de la misma definición).
  // Las columnas pobladas NO se vacían: son dato correcto, medido, y otras pantallas ya las leen.
};
