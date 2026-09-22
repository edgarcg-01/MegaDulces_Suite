'use strict';
/**
 * `[CDRP.4-perf]` — **Rollup de venta por almacén × canal × día, ventana de 200 días.**
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 * El bloque de zonas de «Mi trabajo» pregunta por venta **agregada por almacén**, pero
 * `analytics.sales_daily` está al grano de PRODUCTO: 3.0M filas / heap 1,507 MB. Para el caso de
 * Dirección (6 zonas) la pantalla la toca dos veces y eso era **3.5 de los 4.35 s** que quedaban
 * tras los tres arreglos anteriores.
 *
 * El índice cubriente de `20260921210000` ya había bajado el agregado de **9.7 s a 242 ms**, pero
 * el piso lo pone la cantidad de filas: hay que leer y sumar **249,389** por request. Eso no baja
 * con más índice — baja pre-agregando.
 *
 * ⭐ **Medido: 1,124,926 filas de 200 días colapsan a 4,447.** 253× menos. El bloque deja de sumar
 * un cuarto de millón de filas en cada carga y pasa a leer unas decenas.
 *
 * ── El grano, y la columna que NO se puede recalcular después ────────────────────────────────
 * `(tenant_id, warehouse_id, channel, sale_date)` — 21 almacenes × 7 canales × 200 días.
 *
 * ⛔ `revenue_con_costo` va COMO COLUMNA y no se deriva luego. Es
 * `sum(revenue) FILTER (WHERE cost IS NOT NULL)`, y esa condición vive al grano de PRODUCTO: una
 * vez agregado por almacén ya no se sabe qué parte de la venta traía costo. Es justo el dato con
 * el que `[CDRP.1]` declara la **cobertura** del margen (medido entonces: 689 de 109,884 filas del
 * tramo sin costo). Sin esta columna el bloque tendría que elegir entre no publicar margen o
 * publicarlo sin decir sobre cuánta venta se calculó — y lo segundo es exactamente lo que ADR-056
 * prohíbe.
 *
 * ── Ventana de 200 días ─────────────────────────────────────────────────────────────────────
 * Cubre lo que el consumidor pregunta: frescura (7 d) y el tramo comparado (~2 meses), con margen.
 * Misma ventana que `mv_rd_route_daily_200d` a propósito, para que las dos piernas de la portada
 * tengan el mismo alcance y nadie tenga que recordar dos números distintos.
 *
 * ⛔ **La última venta de una tienda muda queda acotada a 200 días.** Antes se buscaba sin piso.
 * Una tienda que no vende desde hace más de 200 días llega con `ultima` en `null`, igual que una
 * que nunca vendió. Se acepta por lo mismo que en rutas: a los 6 meses «está muerta» y «murió el
 * 12-ago» son la misma respuesta operativa. Lo que NO se hace es inventar una fecha.
 *
 * ⛔ **`analytics.sales_daily` NO se toca y los demás consumidores la siguen leyendo.** Esto es una
 * copia POR COSTO a otro grano, no una segunda fuente: si alguien necesita producto, va a la tabla.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_sales_daily_wh_200d';
const DIAS = 200;

exports.up = async function up(knex) {
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [MV]);
  if (existe.rows[0] && existe.rows[0].t) {
    console.log(`  [CDRP.4-perf] ${MV} ya existe`);
  } else {
    console.log(`  [CDRP.4-perf] materializando ${MV} (ventana ${DIAS} d)…`);
    const t0 = Date.now();
    await knex.raw(`
      CREATE MATERIALIZED VIEW ${MV} AS
      SELECT
        tenant_id,
        warehouse_id,
        channel,
        sale_date,
        sum(revenue)                                      AS revenue,
        sum(cost)                                         AS cost,
        -- ⛔ Ver la cabecera: esto NO se puede reconstruir una vez agregado por almacén.
        sum(revenue) FILTER (WHERE cost IS NOT NULL)      AS revenue_con_costo,
        sum(tickets)                                      AS tickets,
        sum(units)                                        AS units
      FROM analytics.sales_daily
      WHERE sale_date >= current_date - ${DIAS}
      GROUP BY tenant_id, warehouse_id, channel, sale_date`);
    console.log(`  [CDRP.4-perf] materializada en ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  // Sin ÚNICO no hay `REFRESH CONCURRENTLY`, y el refresh bloquearía a quien abre la portada.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_sales_daily_wh_200d_uniq
    ON ${MV} (tenant_id, warehouse_id, channel, sale_date)`);
  // El acceso real: tenant + `IN` de almacenes + rango de fechas.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS mv_sales_daily_wh_200d_lookup
    ON ${MV} (tenant_id, warehouse_id, sale_date)`);

  // Las matviews no soportan RLS: el filtro por `tenant_id` es EXPLÍCITO en cada consulta,
  // mismo criterio que el resto de `analytics.mv_*` desde la Fase C.1.
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  const n = await knex(MV).count({ n: '*' }).first();
  console.log(`  [CDRP.4-perf] ${MV}: ${n.n} fila(s)`);
  if (Number(n.n) === 0) {
    throw new Error(
      `[CDRP.4-perf] ${MV} quedó VACÍA. No se publica una matview vacía: el bloque la leería y ` +
        'declararía "sin venta" para todas las tiendas, que es falso.',
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
