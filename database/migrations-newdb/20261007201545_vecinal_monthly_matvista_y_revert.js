'use strict';
/**
 * `[RR.31]` — **Tira la copia que hice sobre la consulta equivocada, y materializa la que de
 * verdad pesaba.**
 *
 * ── Lo que paso, porque conviene que quede escrito ──────────────────────────────────────────
 *
 * ⛔ `[RR.30]` (la migracion anterior, batch 804) nacio de una medicion MIA que estaba mal.
 * Extraje "la consulta de Ventas por ruta" del fuente del servicio tomando el **primer**
 * `trx.raw` del metodo... y ese primer `raw` es el de la rama `if (factFilter)`, la que **solo
 * corre cuando alguien filtra por SKU o por cliente**. La corri sin esos filtros -- una
 * combinacion que el sistema NUNCA ejecuta -- y medi **44,773 ms**.
 *
 * La consulta que de verdad corre al abrir la pantalla es la del `else`, y cuesta **1,101 ms**.
 * Sigue por encima del gate de 500 ms, pero mi alarma estaba **40 veces** exagerada.
 *
 * ⭐ Es exactamente la trampa que el propio proyecto tiene anotada: *medir la consulta REAL del
 * servicio, no una parecida*. "El primer `trx.raw` del metodo" no es la consulta del metodo
 * cuando el metodo se bifurca.
 *
 * ── Y el dano colateral, que es peor que la medicion ────────────────────────────────────────
 *
 * ⛔ `analytics.mv_route_sales_monthly` quedo en prod **duplicando** `analytics.sales_by_route_monthly`,
 * que ya existe, ya esta agregada y es una TABLA de 375 filas que se sirve en **5 ms**. O sea
 * que materialice una segunda forma de un dato que ya estaba materializado -- justo lo que la
 * regla del proyecto prohibe. Se tira acá.
 *
 * ── Donde estaba el tiempo de verdad, aislado por piernas ───────────────────────────────────
 *
 *  | pierna del UNION                            | 61-137 filas | costo     |
 *  |---------------------------------------------|--------------|-----------|
 *  | `analytics.sales_by_route_monthly` (TABLA)  | 137          | **5 ms**  |
 *  | `analytics.v_kepler_vecinal_monthly` (VISTA)| 61           | **1,087 ms** |
 *
 * ⭐ **El 99% del costo son 61 filas de rutas vecinales**, que se recalculan desde el ODS en
 * cada apertura. Eso si es una copia que falta, no una que sobra.
 *
 * ⚠️ La rama con filtro por SKU/cliente sigue costando lo que cuesta y **queda declarada**: es
 * otra pregunta, con otro grano, y arreglarla es otro trabajo. Lo que no se puede es seguir
 * diciendo que son 45 s al abrir, porque no lo son.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_kepler_vecinal_monthly';
const MAT = 'analytics.mv_kepler_vecinal_monthly';
const SOBRA = 'analytics.mv_route_sales_monthly';
const GATE_MS = 500;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = 0`);

  // ── 1. Tirar la copia que sobra ───────────────────────────────────────────────────────────
  const { rows: [sobra] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS si`, [SOBRA]);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${SOBRA}`);
  console.log(`  · [RR.31] ${SOBRA}: ${sobra.si ? 'existia y se tiro' : 'no existia'}`);

  // ── 2. Materializar la pierna que pesa ────────────────────────────────────────────────────
  const { rows: [hay] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS si`, [VISTA]);
  if (!hay.si) throw new Error(`[RR.31] falta ${VISTA}`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MAT} AS SELECT * FROM ${VISTA}`);
  // La llave natural de la vista. Si no fuera unica esto falla acá, que es donde tiene que
  // fallar: un UNIQUE que no se puede crear significa que el grano no es el que creo que es.
  await knex.raw(`CREATE UNIQUE INDEX mv_kepler_vecinal_monthly_pk
    ON ${MAT} (tenant_id, warehouse_code, route_no, month)`);
  await knex.raw(`CREATE INDEX mv_kepler_vecinal_monthly_mes ON ${MAT} (tenant_id, month)`);
  await knex.raw(`ANALYZE ${MAT}`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MAT} IS
    'RR.31 - copia por costo de v_kepler_vecinal_monthly. Medido: la vista cuesta 1,087 ms para 61 filas y es el 99% de lo que tardaba Ventas por ruta en abrir (la otra pierna, sales_by_route_monthly, son 5 ms). Se refresca con las demas.'`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO dev_ro`);

  // ── Freno 1: PARIDAD al centavo contra la vista viva ──────────────────────────────────────
  const { rows: [par] } = await knex.raw(`
    SELECT (SELECT count(*) FROM ${VISTA})::int                   AS n_viva,
           (SELECT count(*) FROM ${MAT})::int                     AS n_copia,
           (SELECT round(sum(revenue),2) FROM ${VISTA})::text     AS r_viva,
           (SELECT round(sum(revenue),2) FROM ${MAT})::text       AS r_copia`);
  if (par.n_viva !== par.n_copia || par.r_viva !== par.r_copia) {
    throw new Error(`[RR.31] la copia NO cuadra: filas ${par.n_viva} vs ${par.n_copia}, revenue ${par.r_viva} vs ${par.r_copia}`);
  }
  if (Number(par.n_copia) === 0) throw new Error('[RR.31] la copia quedo VACIA');
  console.log(`  · [RR.31] paridad OK: ${par.n_copia} filas · revenue ${par.r_copia}`);

  // ── Freno 2: PROPOSITO. La consulta REAL de la pantalla, con las dos piernas ──────────────
  //
  // ⚠️ Esta vez SI es la del `else` de salesByRoute -- la que corre al abrir. Es la leccion de
  // la migracion anterior: se mide la consulta que el usuario dispara, no la primera que
  // aparece en el fuente.
  const anio = new Date(Date.now() - 6 * 3600 * 1000).getUTCFullYear();
  const PANTALLA = `
    WITH base AS (
      SELECT w.code AS wcode, w.name AS wname, s.route_code, s.route_no,
             to_char(s.month,'MM') AS mes, s.units, s.revenue, s.tickets
        FROM analytics.sales_by_route_monthly s
        JOIN commercial.warehouses w ON w.id = s.warehouse_id
       WHERE s.month >= DATE '${anio}-01-01' AND s.month < DATE '${anio + 1}-01-01'
         AND s.route_code LIKE 'WIN-%' AND COALESCE(s.route_no,'') !~ '^[0-9]V[0-9]'
       UNION ALL
      SELECT v.warehouse_code, w.name, v.route_code, v.route_no,
             to_char(v.month,'MM'), v.units, v.revenue, v.tickets
        FROM FUENTE_VECINAL v
        JOIN commercial.warehouses w ON w.tenant_id = v.tenant_id
         AND w.code = v.warehouse_code AND w.deleted_at IS NULL
       WHERE v.month >= DATE '${anio}-01-01' AND v.month < DATE '${anio + 1}-01-01'
    )
    SELECT wcode, wname, route_code, route_no, mes,
           sum(units) AS units, sum(revenue) AS revenue, sum(tickets) AS tickets
      FROM base GROUP BY 1,2,3,4,5`;

  let t = Date.now();
  const { rows: pant } = await knex.raw(PANTALLA.replace('FUENTE_VECINAL', MAT));
  const msMat = Date.now() - t;
  console.log(`  · [RR.31] la pantalla: ${pant.length} filas · ${msMat} ms (antes 1,101 ms)`);
  if (msMat > GATE_MS) {
    throw new Error(`[RR.31] la pantalla sigue en ${msMat} ms: no alcanza el gate de ${GATE_MS} ms`);
  }

  // ── Freno 3 (PRUEBA NEGATIVA): con la vista viva NO alcanzaba ─────────────────────────────
  t = Date.now();
  await knex.raw(PANTALLA.replace('FUENTE_VECINAL', VISTA));
  const msVista = Date.now() - t;
  if (msVista <= msMat) {
    throw new Error(`[RR.31] con la vista viva tarda ${msVista} ms y con la copia ${msMat} ms: la copia no aporta, no hay razon para materializar`);
  }
  console.log(`  · [RR.31] prueba negativa OK: viva ${msVista} ms -> copia ${msMat} ms`);
};

/**
 * Deshace lo de esta migracion: tira la copia vecinal.
 *
 * ⚠️ NO resucita `mv_route_sales_monthly`: era un error y volver a crearla al revertir seria
 * reinstalar el error. El `down` deshace el cambio bueno, no el arrepentimiento.
 */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
};
