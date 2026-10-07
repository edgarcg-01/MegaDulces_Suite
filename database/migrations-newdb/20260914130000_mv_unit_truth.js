/**
 * WMS-BI.4.3 — `analytics.mv_unit_truth`: el resolvedor de unidad, CACHEADO. Nada más.
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 *
 * Medido con `EXPLAIN (ANALYZE, BUFFERS)` contra PROD el 2026-09-14, sobre la consulta REAL de
 * `/almacen/analisis-bi?tab=movimientos` (página 1, 50 filas, ventana default de 30 días):
 *
 *   Nested Loop Left Join  (ut.warehouse_id = m.warehouse_id AND ut.product_id = m.product_id)
 *     Rows Removed by Join Filter: 8,981,845          <-- para devolver 50 filas
 *
 * O sea: el planner no puede empujar las llaves adentro de `v_unit_truth` (es una vista sobre
 * vistas, una de las cuales corre `percentile_cont` sobre 76,822 renglones de `kdpv_prov_prod`
 * y ordena a disco), así que la resuelve entera y descarta 9 millones de filas **en cada
 * request**. JIT compila 353 funciones. Tiempos medidos de la página: **19.4 s en frío, 3.3 s
 * en caliente**; la misma consulta sin este join: **1.6 s**.
 *
 * Materializar por COSTO es legítimo (GOTCHAS §19). Lo que no es legítimo es materializar un
 * valor INVENTADO — y esto no lo es: la MV es `SELECT *` de la vista canónica, sin una sola
 * transformación. **`analytics.v_unit_truth` sigue siendo la única DEFINICIÓN** de la unidad
 * (ADR-057); esto es una copia de ESA definición, no una segunda.
 *
 * ── Lo que esta migración NO hace, a propósito ─────────────────────────────────────────────
 *
 * ⛔ **No mueve a los demás consumidores.** Sólo `commercial-bi-almacen` pasa a leer la MV. El
 *    otro lector backend (`commercial-analytics.service.ts`) se queda en la vista viva: mover
 *    un consumidor a una copia con rezago es una decisión de producto por pantalla, no un
 *    reemplazo global. Quien lea la MV tiene que DECLARAR su `refreshed_at` (ADR-056).
 *
 * ⛔ **No denormaliza la unidad dentro de `analytics.stock_movements`.** Eso congelaría el
 *    resolvedor: el factor de una fila vieja dejaría de corregirse cuando el resolvedor mejora,
 *    y sería la segunda materialización que ADR-057 y la regla principal prohíben. Se cachea el
 *    RESOLVEDOR, no su resultado pegado al hecho.
 *
 * ── Las dos trampas de una MV que es `SELECT *` ────────────────────────────────────────────
 *
 * ⚠️ **Deriva de esquema.** Si alguien hace `CREATE OR REPLACE VIEW analytics.v_unit_truth`
 *    agregando una columna, la MV **NO** la toma: `REFRESH` re-ejecuta la consulta *congelada al
 *    momento del CREATE*, con la lista de columnas de entonces. El consumidor leería una columna
 *    que no existe → error, o peor, dejaría de pedirla y no se notaría. Por eso esta migración
 *    guarda la lista de columnas en el `COMMENT` y el candado
 *    `database/tests/test-newdb-bi-almacen.js` compara MV vs vista y **se pone rojo** si difieren.
 *    Un gate sin prueba negativa es una intención (ADR-056).
 *
 * ⚠️ **Las MV no soportan RLS** (limitación de Postgres, ya vivida en C.1). El filtro por tenant
 *    va EXPLÍCITO en el join del service (`ut.tenant_id = m.tenant_id`), igual que hoy. Si algún
 *    día alguien lee esta MV sin filtrar por tenant, ve todos los tenants.
 *
 * ⚠️ `CREATE INDEX CONCURRENTLY` es una trampa en esta base — espera TODAS las transacciones más
 *    viejas, incluso ajenas (una migración se sentó 575 s en `Lock/virtualxid`). Índice normal.
 *
 * ── Llave ──────────────────────────────────────────────────────────────────────────────────
 *
 * `(tenant_id, warehouse_id, product_id)`, medido contra PROD antes de escribir esto:
 * 179,824 filas = 179,824 llaves distintas, y **0 NULL** en las tres columnas (lo segundo
 * importa: UNIQUE trata los NULL como distintos, así que una llave nullable no habría
 * garantizado nada y `REFRESH CONCURRENTLY` lo habría descubierto en producción).
 *
 * @param { import("knex").Knex } knex
 */

const MV = `
CREATE MATERIALIZED VIEW analytics.mv_unit_truth AS
SELECT v.*, now() AS refreshed_at
  FROM analytics.v_unit_truth v`;

/** Columnas de la vista, en orden — para detectar deriva de esquema. */
async function colsDe(knex, rel) {
  const r = await knex.raw(
    `SELECT a.attname
       FROM pg_attribute a
      WHERE a.attrelid = ?::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [rel]);
  return r.rows.map((x) => x.attname);
}

exports.up = async function up(knex) {
  const ya = (await knex.raw(`SELECT to_regclass('analytics.mv_unit_truth') t`)).rows[0].t;
  if (!ya) {
    const t0 = Date.now();
    await knex.raw(MV);
    // UNIQUE es requisito de REFRESH ... CONCURRENTLY (sin él, el refresh toma un lock exclusivo
    // y la pantalla ve la MV vacía mientras dura).
    await knex.raw(`CREATE UNIQUE INDEX mv_unit_truth_pk
                      ON analytics.mv_unit_truth (tenant_id, warehouse_id, product_id)`);
    await knex.raw(`ANALYZE analytics.mv_unit_truth`);
    console.log(`  [mv_unit_truth] construida en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  await knex.raw(`GRANT SELECT ON analytics.mv_unit_truth TO app_runtime`);

  // ── Auto-verificación: la copia tiene que ser IGUAL a su original ──
  // (a) mismo número de filas
  const n = (await knex.raw(
    `SELECT (SELECT count(*) FROM analytics.mv_unit_truth)  AS mv,
            (SELECT count(*) FROM analytics.v_unit_truth)   AS vista`)).rows[0];
  if (Number(n.mv) !== Number(n.vista)) {
    throw new Error(`mv_unit_truth tiene ${n.mv} filas y la vista ${n.vista}: la copia no cuadra`);
  }
  if (Number(n.mv) < 1000) {
    throw new Error(`mv_unit_truth quedó con ${n.mv} filas: la vista está vacía o el CREATE falló`);
  }

  // (b) mismas columnas, en el mismo orden (deriva de esquema — ver el encabezado).
  const cv = await colsDe(knex, 'analytics.v_unit_truth');
  const cm = (await colsDe(knex, 'analytics.mv_unit_truth')).filter((c) => c !== 'refreshed_at');
  if (cv.join(',') !== cm.join(',')) {
    throw new Error(
      `mv_unit_truth no tiene las columnas de la vista.\n  vista: ${cv.join(', ')}\n  mv:    ${cm.join(', ')}`);
  }

  // ⚠️ `COMMENT ON ... IS` NO acepta parámetro: exige literal. Se escapa a mano.
  const comentario = (
    `WMS-BI.4.3: copia CACHEADA de analytics.v_unit_truth (ADR-057), materializada por COSTO - `
    + `el join vivo descartaba 8,981,845 filas para devolver 50 en /almacen/analisis-bi. `
    + `NO es una segunda definicion: es SELECT * de la vista canonica. `
    + `Refresca AnalyticsRefreshService (job analytics_refresh_unit_truth). `
    + `Quien la lea DEBE declarar refreshed_at. Columnas al crearla: ${cv.join(', ')}`
  ).replace(/'/g, "''");
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_unit_truth IS '${comentario}'`);

  console.log(`  [mv_unit_truth] ${n.mv} filas, ${cv.length} columnas + refreshed_at — cuadra con la vista`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_unit_truth CASCADE`);
};
