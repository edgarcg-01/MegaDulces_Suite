'use strict';
/**
 * `[MR.8.5]` — **`analytics.v_erp_unit_cost` cuesta 1.25 s cada vez que alguien la toca, y
 * `/comercial/rentabilidad` la toca en cada consulta.**
 *
 * ── Qué se midió (prod, 2026-09-29) ─────────────────────────────────────────────────────────
 * La regla del proyecto es que una pantalla arriba de **1 s no funciona**. Medido:
 * ```
 *   overview 30d          2,593 ms
 *   breakdown SKU  30d    4,726 ms
 *   breakdown suc  30d    6,483 ms
 *   breakdown SKU 365d   12,493 ms
 * ```
 * Descompuesto, el tiempo NO estaba donde uno esperaría (el fact agregado son 223 ms a 30 d):
 * ```
 *   componente                         30d        90d       365d
 *   salesAgg (mv_sales_blended)      223 ms     518 ms    2,044 ms
 *   stk (stock x v_erp_unit_cost)  ~1,250 ms  ~1,250 ms  ~1,250 ms   <- CONSTANTE
 *   resto                            ~100 ms    ~100 ms    ~100 ms
 * ```
 * Y el `breakdown` **ejecutaba todo eso TRES veces** (filas + conteo + totales). Eso se arregló
 * en el servicio con ventanas (`COUNT(*) OVER ()`), en el mismo commit que esta migración.
 *
 * ── Por qué la vista es cara, y por qué filtrarla no sirve ──────────────────────────────────
 * `v_erp_unit_cost` **enumera el producto cartesiano completo a propósito** (180,384 filas,
 * 161,147 buffers por pase): sin esa enumeración, una celda ausente llega NULL a un LEFT JOIN y
 * se lee como sana — es la razón por la que `[KE.3]` la escribió así y **no se toca**.
 * Medido: acotarla con un semi-join a las celdas con existencia igual cuesta **1,158 ms**. El
 * costo es la enumeración, no el filtro. La única palanca es materializarla.
 *
 * ── Qué hace esta migración ─────────────────────────────────────────────────────────────────
 * Crea `analytics.mv_erp_unit_cost` como **`SELECT * FROM analytics.v_erp_unit_cost`**, literal.
 * No reimplementa nada: es la misma vista, materializada. Por construcción **no puede divergir en
 * lógica** — sólo en frescura, y para eso se registra su refresco y su umbral.
 * Es el mismo trato que `20260924235000` le dio a `v_product_box_factor` (AX-PERF.1, que bajó un
 * lookup de 10,422 ms a 5.7 ms).
 *
 * ⛔ **La vista NO se retira ni se cambia.** La leen otros nueve servicios y varios necesitan el
 * dato al momento. Esta matview existe para el camino CALIENTE (una pantalla que se abre y se
 * filtra), no para reemplazarla.
 *
 * ── Lo que esta migración NO arregla, dicho con su número ───────────────────────────────────
 * ```
 *   ventana   antes      despues (proyectado)   gate
 *    30 d   4,726 ms        ~432 ms             OK
 *    90 d       —           ~727 ms             OK
 *   365 d  12,493 ms      ~2,253 ms             ⛔ SIGUE ARRIBA
 * ```
 * A 365 días manda `salesAgg`: agrega **2,808,558 filas** de `mv_sales_blended` en 2,044 ms.
 *
 * ⛔ **Y un índice NO lo arregla, medido — no supuesto.** El plan hoy elige
 * `ix_mv_sales_blended_channel` en vez del cubridor `ix_mv_sales_blended_cover2` porque ese
 * INCLUDE **no trae `unit_kind`**, y la consulta lo pide. Quitando esa columna la misma consulta
 * baja de **2,230 ms a 1,374 ms** — o sea que arreglar el índice ganaría ~856 ms y **seguiría
 * arriba de 1 s**. Agregar 2.8 M filas no baja del segundo por más índice que se le ponga.
 *
 * La salida real es un **rollup propio** (una matview de `salesAgg` por ventana), que es un
 * sprint aparte con su propia decisión: introduce un segundo linaje del margen y hay que probar
 * que no diverge del fact. Se declara acá con su número. **No se sube ningún umbral para taparlo.**
 *
 * Aditiva. No toca ningún objeto existente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⚠️ Sin `WITH NO DATA`: poblarla es UN pase de la vista, medido en ~968 ms para 180,384 filas.
  // Cabe de sobra en la migración, y nacer vacía dejaría a la pantalla valuando el inventario en
  // cero hasta el primer refresh — que es peor que tardar un segundo más acá.
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_unit_cost`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_unit_cost AS
      SELECT * FROM analytics.v_erp_unit_cost
    WITH DATA`);

  // El UNIQUE habilita `REFRESH CONCURRENTLY`: sin el, cada refresco deja la pantalla leyendo
  // vacio. El grano de la vista es (tenant, almacen, producto) y esta enumerado, asi que es unico.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_erp_unit_cost
        ON analytics.mv_erp_unit_cost (tenant_id, warehouse_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_erp_unit_cost TO app_runtime`);

  // ── Compuertas: la copia tiene que ser la vista, no parecerse ─────────────────────────────
  const [{ mv, vista }] = (
    await knex.raw(`
      SELECT (SELECT count(*) FROM analytics.mv_erp_unit_cost) mv,
             (SELECT count(*) FROM analytics.v_erp_unit_cost)  vista`)
  ).rows;
  console.log(`  · [MR.8.5] mv_erp_unit_cost ${mv} filas · vista ${vista} filas.`);

  // (a) Misma cardinalidad. Si difieren, el UNIQUE colapso filas o la vista cambio bajo los pies.
  if (Number(mv) !== Number(vista)) {
    throw new Error(
      `[MR.8.5] la matview tiene ${mv} filas y la vista ${vista}: no es una copia. ` +
        'Revisar si (tenant, almacen, producto) dejo de ser unico en v_erp_unit_cost.',
    );
  }
  // (b) NO puede nacer vacia. Es el modo de falla de esta familia: una matview vacia se ve
  //     "poblada y fresca" para el sensor, y la pantalla valua el inventario en cero.
  //     Pasaria si el refresh corriera con un rol sin BYPASSRLS: catalog.products y
  //     commercial.warehouses tienen FORCE ROW LEVEL SECURITY.
  if (!(Number(mv) > 100000)) {
    throw new Error(
      `[MR.8.5] la matview quedo con ${mv} filas (se esperaban ~180,000). ` +
        'Si dio 0: el rol que materializo no tiene BYPASSRLS y la RLS forzada la vacio en silencio.',
    );
  }
  // (c) El dinero cuadra al peso. Cardinalidad igual con valores distintos seria peor que vacia.
  const [{ d }] = (
    await knex.raw(`
      SELECT ROUND(ABS(
               COALESCE((SELECT SUM(costo_unitario) FROM analytics.mv_erp_unit_cost), 0)
             - COALESCE((SELECT SUM(costo_unitario) FROM analytics.v_erp_unit_cost), 0)), 4) d`)
  ).rows;
  if (Number(d) > 0.01) {
    throw new Error(`[MR.8.5] la suma de costo_unitario difiere en ${d} entre matview y vista.`);
  }
  console.log(`  ✓ [MR.8.5] copia verificada: misma cardinalidad y suma de costo (delta ${d}).`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_unit_cost IS
    $$[MR.8.5] Copia materializada de analytics.v_erp_unit_cost, sin un solo cambio de logica
    (el cuerpo es SELECT * FROM la vista). Existe por COSTO: la vista enumera el cartesiano
    completo (180,384 filas / 161,147 buffers) y cuesta ~1.25 s por pase, que
    /comercial/rentabilidad pagaba en cada consulta.

    CUANDO USAR CUAL:
      · camino caliente (pantallas que se abren y se filtran) -> esta matview
      · dato al momento (importers, conteos, cualquier cosa que acabe de escribir stock o costo)
        -> la VISTA. Esta copia es tan fresca como su ultimo refresh.

    NO lleva security_invoker: es propiedad de vistas, no de matviews. Filtrar tenant_id explicito.

    ⛔ Si el refresh se mueve a un rol sin BYPASSRLS se materializa VACIA y el sensor la ve
    "poblada": catalog.products y commercial.warehouses tienen FORCE ROW LEVEL SECURITY.$$`);

  // El refresco va en el array `MVS` de 15 min de `AnalyticsRefreshService` (mismo commit). Ese
  // carril late como `analytics_refresh`, que YA tiene umbral en `CRON_JOBS` (warnH 1 / critH 3),
  // así que esta matview queda vigilada sin renglón nuevo — no cae en el `cfg ? classify : 'ok'`.
  console.log('  ✓ [MR.8.5] el refresco va en el array de 15 min (carril `analytics_refresh`, ya con umbral).');
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_unit_cost`);
  console.log('  ✓ [MR.8.5] down: matview removida. La vista nunca se toco.');
};
