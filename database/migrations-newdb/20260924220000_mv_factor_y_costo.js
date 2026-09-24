/**
 * [EX-PERF.2] Las dos vistas caras de `/compras/existencia`, materializadas por COSTO.
 *
 * ── El problema, MEDIDO contra prod (2026-09-24) ────────────────────────────────────────────
 * La pantalla tardaba **27 s de LCP**. La consulta se sacó del log de Postgres con sus
 * parámetros —no una parecida— y se corrió tal cual: **939,977 páginas de buffer (~7.5 GB) para
 * devolver 50 filas**, con el 100 % del costo dentro de su CTE `src`. Atribuido nodo por nodo:
 *
 *     vista de existencia (base) ............ 226,674
 *     + replenishment_plan y reorder_policy .. 431,569
 *     + v_warehouse_box_factor ............... 194,173   <- el join mas caro
 *     + v_kepler_unit_cost ...................  87,557
 *
 * Esas dos son VISTAS que se calculaban ENTERAS en cada carga sólo para armar el hash del join.
 * Ahora esa pasada se paga UNA vez por ciclo, en un carril, y no una vez por cada persona que
 * abre la pantalla.
 *
 * ── El premio, medido ANTES de construir nada ───────────────────────────────────────────────
 * Se corrió la consulta real con las dos vistas reemplazadas por tablas TEMP —que es exactamente
 * lo que un matview le da al planificador— dentro de una transacción con ROLLBACK:
 *
 *     tal cual hoy ................. 4,910 ms
 *     con las dos materializadas ... 1,842 ms  ·  segunda pasada 1,353 ms     3.6x
 *
 * Construirlas cuesta ~3.6 s (3,068 ms + 514 ms), que es lo que pagará el carril por ciclo.
 *
 * `GOTCHAS §19` lo permite explícitamente: *"Materializar por costo sí es legítimo; el pecado es
 * materializar un valor INVENTADO, sin origen verificable en la primaria"*. Acá el cuerpo es
 * literalmente `SELECT * FROM <la vista>`: **no puede divergir de su definición**, que es lo que
 * salió mal en el primer intento de esta misma fase.
 *
 * ── ⛔ POR QUÉ NO SE REEMPLAZA EL CUERPO DE LAS VISTAS ──────────────────────────────────────
 * La tentación era `CREATE OR REPLACE VIEW v_warehouse_box_factor AS SELECT * FROM mv_...`, que
 * daría la mejora a todos los consumidores sin tocar una línea de código. Se descartó con
 * medición: **4 vistas dependen de ella** — `v_existencia_dictamen`,
 * `v_product_box_factor_consensus`, `v_unit_rung_audit` y **`v_unit_truth`**, que es el
 * resolvedor canónico de unidades de ADR-057. Cambiarle el cuerpo le cambiaría la frescura a la
 * verdad de unidades de toda la plataforma, **en silencio y sin que nadie lo pidiera**.
 * Las vistas quedan intactas; estos materializados son objetos NUEVOS y sólo los lee la pantalla
 * de existencia, que ya declara su frescura.
 *
 * ── ⛔ SIN COLUMNAS DE RELOJ ────────────────────────────────────────────────────────────────
 * Verificado antes de escribir esto: ninguna de las dos vistas trae `computed_at`, `_at`, `now()`
 * ni equivalente. Importa porque `REFRESH ... CONCURRENTLY` compara la FILA COMPLETA con
 * `(y.*) IS DISTINCT FROM (x.*)`: una sola columna que cambie por construcción hace que el 100 %
 * parezca distinto y CONCURRENTLY termine aplicando la tabla entera — le costó a
 * `analytics.mv_caja_movimientos` **12.3 GB de WAL por día** hasta este mismo 2026-09-24.
 * La edad del dato vive en `analytics.cron_run_log`, llave `mv_existencia_aux_refresh`.
 *
 * @param { import("knex").Knex } knex
 */

const PARES = [
  ['analytics.mv_warehouse_box_factor', 'analytics.v_warehouse_box_factor', 'ux_mv_warehouse_box_factor'],
  ['analytics.mv_kepler_unit_cost', 'analytics.v_kepler_unit_cost', 'ux_mv_kepler_unit_cost'],
];

exports.up = async function (knex) {
  for (const [mv, vista, ux] of PARES) {
    const reg = await knex.raw(`SELECT to_regclass(?) AS t`, [vista]);
    if (!reg.rows[0] || !reg.rows[0].t) continue; // entorno sin esa vista: nada que derivar

    await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${mv} CASCADE`);
    // El cuerpo es la vista, tal cual. Cero copia de lógica = cero divergencia posible.
    await knex.raw(`CREATE MATERIALIZED VIEW ${mv} AS SELECT * FROM ${vista}`);

    // ⚠️ El UNIQUE no es decorativo: sin él `REFRESH ... CONCURRENTLY` no está permitido, y sin
    // CONCURRENTLY el refresh toma un lock exclusivo que deja la pantalla EN BLANCO mientras
    // corre. Medido antes de elegir la llave: las dos vistas dan 0 duplicados por este trío.
    await knex.raw(`CREATE UNIQUE INDEX ${ux} ON ${mv} (tenant_id, warehouse_id, product_id)`);
    await knex.raw(`GRANT SELECT ON ${mv} TO app_runtime`);

    // ── Candado: que no nazca corto sin que nadie se entere ────────────────────────────────
    // Un materializado con menos filas no da error: da una existencia sin factor ni costo, que
    // la pantalla muestra como "sin valuar". Si no cuadra con su vista, la migración FALLA acá.
    const chk = await knex.raw(
      `SELECT (SELECT count(*) FROM ${mv}) AS m, (SELECT count(*) FROM ${vista}) AS v`);
    const { m, v } = chk.rows[0];
    if (Number(v) > 0 && Number(m) !== Number(v)) {
      throw new Error(`${mv} quedó con ${m} filas y ${vista} tiene ${v}. No se materializa a medias.`);
    }
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_warehouse_box_factor IS
    'EX-PERF.2 - copia materializada de analytics.v_warehouse_box_factor, POR COSTO (GOTCHAS 19). '
    'Medido 2026-09-24: en la consulta de /compras/existencia este join aportaba 194,173 de las '
    '939,977 paginas que costaba devolver 50 filas. La vista NO se toca: tiene 4 dependientes, '
    'entre ellas v_unit_truth (el resolvedor canonico de unidades, ADR-057), y cambiarle el cuerpo '
    'le moveria la frescura a toda la plataforma en silencio. Solo la lee existencia.service.ts. '
    'Sin columnas de reloj a proposito; la edad sale de analytics.cron_run_log.'`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_unit_cost IS
    'EX-PERF.2 - copia materializada de analytics.v_kepler_unit_cost, POR COSTO (GOTCHAS 19). '
    'Aportaba 87,557 paginas al mismo join. Mismo criterio que su hermana: la vista queda intacta.'`);
};

exports.down = async function (knex) {
  // El servicio sabe leer las VISTAS cuando estos materializados no existen, así que borrarlos
  // devuelve la pantalla a su comportamiento anterior: más lenta, pero correcta.
  for (const [mv] of PARES) await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${mv} CASCADE`);
};
