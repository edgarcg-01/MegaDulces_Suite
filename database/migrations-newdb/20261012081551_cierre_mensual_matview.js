'use strict';
/**
 * `[CPA.0.2]` — `analytics.mv_contpaqi_cierre_mensual`: el semáforo materializado.
 *
 * ── Por qué, con el número que lo obliga ────────────────────────────────────────────────────
 * ⛔ **La consulta REAL del servicio mide 900–1,291 ms** (mediana **1,078**), medido contra prod
 * el 2026-10-12 sobre 9 corridas. No es el `count(*)` de 563 ms que yo venía reportando: ésa no
 * es la consulta que corre nadie. El servicio pide `SELECT *` de 13 meses con `ORDER BY`, y eso
 * cuesta el doble. *Medir una consulta parecida es no medir.*
 *
 * El gate del proyecto son **500 ms**. No hay forma de llegar afinando SQL, y se probaron dos:
 *
 *  1. **Filtro de cuentas por RANGOS** en vez de `left(cuenta,4) IN (…)`, para que el planificador
 *     pueda usar `ix_gll_cuenta`. **Lo usa** (Bitmap Heap Scan) y el tiempo **no cambia**:
 *     123 contra 124 ms de mediana. El escaneo ya era barato.
 *  2. **Reformular la señal** sacando el `LEFT JOIN` de las 141,914 líneas contra las 231 pólizas
 *     futuras, y restando el provisional aparte. Aislada es más rápida (193 contra 244 ms)…
 *     ⛔ **y dentro de la vista es PEOR: 643 contra 563 ms de mediana.** Al referenciarse dos
 *     veces, `fam_de` se materializa, y eso cuesta más que el merge-join que ahorra. Paridad
 *     perfecta (110 filas, 0 diferencias) y aun así **se descartó**. *Una optimización medida en
 *     aislamiento miente sobre el conjunto.*
 *
 * ── Qué se materializa, y qué NO ────────────────────────────────────────────────────────────
 * ⭐ La matvista es `SELECT * FROM` la vista: **la definición sigue viviendo en un solo lugar**.
 * Cambiar la regla es cambiar la vista; acá no se repite ni una línea de lógica.
 *
 * `refrescado_en` viaja en cada fila para que el consumidor pueda **declarar la edad del dato**.
 * Son DOS frescuras distintas y las dos se publican: `data_as_of` (cuándo llegó la última póliza)
 * y `refrescado_en` (cuándo se recalculó el veredicto). Un tablero que sólo muestra la primera
 * dice "al minuto" sobre un cálculo de ayer.
 *
 * ⚠️ **Postgres NO aplica RLS a una matvista** (lección de `[C.1]`). Por eso `tenant_id` viaja en
 * la llave y **el servicio filtra explícitamente**. El `GRANT` es de sólo lectura.
 *
 * ⚠️ El índice UNIQUE no es adorno: sin él `REFRESH CONCURRENTLY` no es posible, y un `REFRESH`
 * a secas toma `ACCESS EXCLUSIVE` — la pantalla se quedaría colgada cada vez que corre el carril.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_contpaqi_cierre_mensual AS
    SELECT v.*, now() AS refrescado_en
      FROM analytics.v_contpaqi_cierre_mensual v`);

  // Sin esto no hay REFRESH CONCURRENTLY, y sin CONCURRENTLY la pantalla se bloquea en cada corrida.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_contpaqi_cierre_pk
      ON analytics.mv_contpaqi_cierre_mensual (tenant_id, anio_mes, familia)`);

  await knex.raw(`GRANT SELECT ON analytics.mv_contpaqi_cierre_mensual TO app_runtime`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_contpaqi_cierre_mensual IS
    'CPA.0.2 — el semaforo de cierre materializado. Es SELECT * de v_contpaqi_cierre_mensual: la definicion vive en la VISTA, aca no se repite logica. Motivo: la consulta real del servicio medía 900-1,291 ms (mediana 1,078) contra un gate de 500. Se probaron y DESCARTARON dos optimizaciones de SQL (rangos de cuenta: sin efecto; reformular la senal: mas lenta dentro de la vista aunque mas rapida aislada). Postgres NO aplica RLS a una matvista: el tenant_id viaja en la llave y el servicio filtra explicito.'`);

  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM analytics.mv_contpaqi_cierre_mensual`);
  console.log(`  [CPA.0.2] matvista creada con ${rows[0].n} filas`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_contpaqi_cierre_mensual`);
};
