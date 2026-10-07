'use strict';
/**
 * `[CDRP.4-perf]` — **Matview de la venta diaria por ruta, ventana de 200 días.**
 *
 * ── El problema, medido contra prod ─────────────────────────────────────────────────────────
 * `analytics.v_rd_route_daily` es una **vista sobre otra vista**: `v_route_sales_lines` →
 * `wincaja.v_sales_lines`, con `Hash Right Join` contra `wincaja.articulos` y doble
 * `GroupAggregate`. **Se materializa entera en cada consulta**, así que cada toque cuesta
 * millones de buffers aunque se acote, y el bloque de zonas de «Mi trabajo» **la toca TRES veces**
 * (frescura, ventas del tramo, última venta de las rutas mudas).
 *
 * Tras bajar los otros dos cuellos de botella (índice cubriente de `sales_daily` 9.7 s → 242 ms;
 * piso de 120 días en la última venta 19.7 s → 828 ms), esos tres toques son **11.3 de los 12.4 s**
 * que cuesta la portada de Dirección. El resto de la pantalla suma menos de un segundo.
 *
 * ── Por qué matview y NO DuckDB ─────────────────────────────────────────────────────────────
 * ⛔ **La API vive en Railway y DuckDB vive en `md` (192.168.0.222, LAN on-prem): no se
 * alcanzan.** En el camino de carga de una pantalla servida desde Railway, DuckDB no es una
 * opción física. Y ADR-075 ya lo había decidido con un spike medido: **rollups fijos y
 * precomputables → matview nativo**; DuckDB es para exploratorio ad-hoc sobre hechos grandes.
 * Esto es un rollup fijo.
 *
 * ── Por qué 200 días y no toda la historia ──────────────────────────────────────────────────
 * El costo del `REFRESH` es el de materializar la vista, y **escala con el rango** (medido con
 * `EXPLAIN (ANALYZE, BUFFERS)`):
 *
 *     toda la historia  →  567,943,892 buffers   (~60-75 s)
 *     180 días          →  127,268,651
 *     120 días          →   62,057,692
 *
 * Con toda la historia sólo se podría refrescar de noche, y eso **le quitaría el día en curso a
 * la portada del director** — que es justo lo que va a mirar. Con 200 días el refresh es barato y
 * puede correr cada 30 min, así que el dato de hoy está.
 *
 * ⭐ Y 200 días **cubre todo lo que el bloque pregunta**: frescura (7 d), ventas del tramo (~2
 * meses) y el piso de la última venta (120 d), con margen. No es un recorte arbitrario: es el
 * alcance real del consumidor.
 *
 * ⛔ **Los demás consumidores siguen leyendo la VISTA, no esto.** `commercial-analytics` y
 * `commercial-commissions` la usan y pueden pedir rangos viejos; una matview de 200 días les
 * devolvería de menos **en silencio**, que es la peor forma de romper algo. Por eso el nombre
 * lleva la ventana adentro (`_200d`) y esta migración **no toca la vista**.
 *
 * ── Tamaño ──────────────────────────────────────────────────────────────────────────────────
 * Medido: **2,174 filas** en 180 días, y el grano `(tenant_id, route_code, business_date, source)`
 * es ÚNICO (2,174 de 2,174). O sea: la matview es diminuta y admite `REFRESH CONCURRENTLY`, que
 * es lo que permite refrescarla sin bloquear a quien esté leyendo la portada.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_rd_route_daily_200d';
const DIAS = 200;

exports.up = async function up(knex) {
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [MV]);
  if (existe.rows[0] && existe.rows[0].t) {
    console.log(`  [CDRP.4-perf] ${MV} ya existe`);
  } else {
    console.log(`  [CDRP.4-perf] materializando ${MV} (ventana ${DIAS} d)…`);
    const t0 = Date.now();
    /*
     * `SELECT *` a propósito: esto es una COPIA POR COSTO de la vista, no una definición nueva.
     * Si alguien le agrega una columna a `v_rd_route_daily`, se recrea esta matview y listo — no
     * hay una segunda lógica que pueda divergir de la primera (regla: derivar, no reimplementar).
     */
    await knex.raw(`
      CREATE MATERIALIZED VIEW ${MV} AS
      SELECT * FROM analytics.v_rd_route_daily
      WHERE business_date >= current_date - ${DIAS}`);
    console.log(`  [CDRP.4-perf] materializada en ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  /*
   * ⛔ El ÚNICO no es cosmético: sin un índice único, `REFRESH MATERIALIZED VIEW CONCURRENTLY`
   * no se puede usar, y el refresh bloquearía a todo el que esté abriendo la portada.
   * Verificado antes de crearlo: 2,174 filas / 2,174 combinaciones distintas.
   */
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_rd_route_daily_200d_uniq
    ON ${MV} (tenant_id, route_code, business_date, source)`);
  // El acceso real del bloque: filtra por tenant + un `IN` de rutas + rango de fechas.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS mv_rd_route_daily_200d_lookup
    ON ${MV} (tenant_id, route_code, business_date)`);

  // ⚠️ Las matviews NO soportan RLS (Postgres). El filtro por `tenant_id` es EXPLÍCITO en cada
  // consulta, igual que en el resto de `analytics.mv_*` (mismo criterio desde la Fase C.1).
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  const n = await knex(MV).count({ n: '*' }).first();
  console.log(`  [CDRP.4-perf] ${MV}: ${n.n} fila(s)`);
  if (Number(n.n) === 0) {
    // Cero filas en una ventana de 200 días no es "poca venta": es que la vista no devolvió nada.
    throw new Error(
      `[CDRP.4-perf] ${MV} quedó VACÍA. No se publica una matview vacía: el bloque la leería y ` +
        'declararía "sin venta" para todas las rutas, que es falso.',
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
