'use strict';
/**
 * `[RD.45]` — **La foto del camion, materializada: es la HOJA DE CONTEO.**
 *
 * `analytics.v_rd_route_photo` es lo que cada camioneta declara de si misma (FDW al runner), o
 * sea **exactamente lo que hoy se imprime en papel y se recorre con una regla**. Al convertirla
 * en la hoja de una pantalla de conteo deja de ser un reporte que alguien mira una vez al dia y
 * pasa a ser lo que una persona abre 300 veces seguidas, renglon por renglon.
 *
 * ── Lo medido antes (solo lectura, prod, 2026-10-07) ────────────────────────────────────────
 *  · La hoja de UNA ruta (267 renglones) tarda **2,642 ms** contra la vista. El gate del
 *    proyecto es 500 ms, asi que como vista NO sirve para esto.
 *  · El indice de las 11 rutas tarda **390 ms** — pasa raspando, y es la pantalla de entrada.
 *  · La causa no es el FDW: es que la vista recalcula `vocab` (todo `route_push_lines`) y el
 *    empalme de **toda la flota** aunque se filtre una sola ruta. Filtrar no ahorra nada.
 *  · Tamano real: **2,989 renglones** en 10 rutas (254 a 342 por camion). La 505 no tiene foto
 *    desde el 10-sep y **se declara**, no se esconde.
 *
 * ── Por que una copia NO viola la regla de "nunca copiar tablas" ────────────────────────────
 *
 * ⭐ Materializar por COSTO es lo que `GOTCHAS §19` permite: el pecado es materializar un valor
 * **inventado**. Aca no se inventa nada — es `SELECT *` de la vista, con un candado de paridad
 * que lo prueba al centavo. Mismo criterio y mismo autor que `mv_rd_route_opening` (281 ms -> 1 ms)
 * y `mv_rd_route_day`, de esta misma fase.
 *
 * ⚠️ **Lo que la copia cuesta: frescura.** Se refresca con los demas (cada 30 min), asi que entre
 * el push de la camioneta y la hoja puede haber hasta media hora de rezago. Es tolerable porque
 * la foto es **diaria** (un push por camion por dia), pero NO se da por supuesto: `foto_fecha`
 * viaja en cada renglon y la pantalla la publica. Un conteo contra una foto de ayer sigue siendo
 * un conteo valido — contra una foto de ayer que se cree de hoy, no.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.v_rd_route_photo';
const MAT = 'analytics.mv_rd_route_photo';
/** Gate del proyecto para una consulta que sirve una pantalla. */
const GATE_MS = 500;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: [hay] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS si`, [VISTA]);
  if (!hay.si) throw new Error(`[RD.45] falta ${VISTA}: correr primero 20261006230000_rd_route_photo_fdw`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MAT} AS SELECT * FROM ${VISTA}`);

  // La llave. Si la vista pudiera devolver dos renglones del mismo (ruta, sku, unidad) esto
  // falla aca y la migracion no entra -- que es lo correcto: una hoja de conteo con el mismo
  // producto dos veces le pide a una persona que lo cuente dos veces.
  // Ademas habilita REFRESH CONCURRENTLY, sin el cual el refresco bloquea a quien este contando.
  await knex.raw(`CREATE UNIQUE INDEX mv_rd_route_photo_pk ON ${MAT} (tenant_id, route_no, sku, unidad)`);
  // El indice de la pantalla de entrada: una fila por ruta.
  await knex.raw(`CREATE INDEX mv_rd_route_photo_ruta ON ${MAT} (tenant_id, route_no)`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MAT} IS
    'RD.45 - copia por costo de v_rd_route_photo: es la HOJA DE CONTEO de un camion. La vista tardaba 2,642 ms por ruta (gate 500) porque recalcula el empalme de toda la flota aunque se filtre una. Se refresca cada 30 min; foto_fecha viaja en cada renglon porque el rezago es real y se declara.'`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${MAT} TO dev_ro`);

  // ── Freno 1: PARIDAD. La copia dice lo mismo que la vista, al centavo y por ruta ──────────
  const { rows: [par] } = await knex.raw(`
    WITH v AS (SELECT route_no, count(*) n, sum(qty) q, sum(importe) i FROM ${VISTA} GROUP BY 1),
         m AS (SELECT route_no, count(*) n, sum(qty) q, sum(importe) i FROM ${MAT}   GROUP BY 1)
    SELECT count(*)::int AS rutas,
           count(*) FILTER (WHERE v.n IS DISTINCT FROM m.n)::int                        AS difieren_filas,
           count(*) FILTER (WHERE round(coalesce(v.i,0),2) <> round(coalesce(m.i,0),2))::int AS difieren_importe
      FROM v FULL JOIN m USING (route_no)`);
  if (Number(par.rutas) === 0) {
    throw new Error('[RD.45] la foto no tiene una sola ruta: el FDW no esta respondiendo, revisar antes de seguir');
  }
  if (Number(par.difieren_filas) || Number(par.difieren_importe)) {
    throw new Error(`[RD.45] la copia NO cuadra con la vista: ${par.difieren_filas} ruta(s) con otro conteo de renglones, ${par.difieren_importe} con otro importe`);
  }
  console.log(`  · [RD.45] paridad OK en ${par.rutas} ruta(s)`);

  // ── Freno 2: PROPOSITO. La hoja de UNA ruta tiene que entrar en el gate ───────────────────
  //
  // Se mide la consulta REAL que sirve la pantalla (con el join al catalogo por el NOMBRE del
  // producto), no la matvista pelada: medir una consulta parecida no mide nada.
  const { rows: [una] } = await knex.raw(`SELECT route_no FROM ${MAT} GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const HOJA = `
    SELECT f.sku, f.unidad, coalesce(p.description, f.sku) AS producto, f.qty, f.costo_unitario
      FROM ${MAT} f
      LEFT JOIN catalog.products p
        ON p.tenant_id = f.tenant_id AND btrim(p.sku) = f.sku AND p.deleted_at IS NULL
     WHERE f.route_no = ?`;
  let t = Date.now();
  const { rows: hoja } = await knex.raw(HOJA, [una.route_no]);
  const msMat = Date.now() - t;
  if (msMat > GATE_MS) {
    throw new Error(`[RD.45] la hoja de la ruta ${una.route_no} tarda ${msMat} ms con la copia: no alcanza el gate de ${GATE_MS} ms, la copia no resolvio el problema`);
  }

  // ── Freno 3 (PRUEBA NEGATIVA): y la vista NO lo alcanzaba ─────────────────────────────────
  //
  // Sin esto, el freno 2 se pondria verde igual si la vista ya fuera rapida -- o sea declararia
  // ganancia donde no hubo ninguna, que es la forma mas facil de justificar una copia inutil.
  t = Date.now();
  await knex.raw(HOJA.replace(MAT, VISTA), [una.route_no]);
  const msVista = Date.now() - t;
  if (msVista <= msMat) {
    throw new Error(`[RD.45] la vista tarda ${msVista} ms y la copia ${msMat} ms: la copia NO es mas rapida, no hay razon para materializar`);
  }
  console.log(`  · [RD.45] hoja de la ruta ${una.route_no} (${hoja.length} renglones): vista ${msVista} ms -> copia ${msMat} ms`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila mas. La vista queda intacta. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MAT}`);
};
