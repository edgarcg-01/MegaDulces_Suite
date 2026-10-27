'use strict';
/**
 * `[CGA-A.55.1]` — `finance.caos_denom_valor()` vuelve a reconocer las denominaciones. En prod
 * devuelve NULL para TODA llave ('500', '1000', '0.5m'…), así que el trigger
 * `finance.caos_link_billetes()` rechaza con `CAOS_LINK_BILLETES_FORMA` cualquier enlace de CAOS
 * que declare billetes, aunque estén bien.
 *
 * ── La causa (reproducida con knex 3.3.0) ──────────────────────────────────────────────────
 *  `20261026110741` escribió la regex con dos `?` dentro de un `knex.raw` SIN bindings. Knex pasa
 *  TODA sentencia por `client.positionBindings()` (`query-executioner.js#enrichQueryObject`), haya
 *  bindings o no, y cambia cada `?` no escapado por `$1`, `$2`… ANTES de mandarla. Dentro de un
 *  cuerpo `$fn$…$fn$` Postgres no protesta: guarda el texto. Lo que quedó en prod
 *  (`pg_proc.prosrc`, 2026-10-26):
 *
 *      escrito : k ~ '^[0-9]+(\.[0-9]+)?m?$'
 *      guardado: k ~ '^[0-9]+(\.[0-9]+)$1m$2$'      ← no casa con ninguna llave
 *
 *  Es la trampa de `docs/GOTCHAS.md` §71, por segunda vez: aquella migración ya advertía «ni un
 *  `?` en el SQL» y el `?` se coló en la regex.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-26) ───────────────────────────────────────
 *  · `caos_denom_valor` de '500', '1000', '20', '0.5m' y '10m' → NULL las cinco.
 *  · `finance.caos_cash_links`: 119 filas, 0 con `billetes`, 0 con `cambio`. El defecto está
 *    LATENTE (el trigger sale antes si los dos vienen NULL) y estalla el día que la pantalla
 *    mande billetes en el enlace: la captura entera se revierte.
 *  · Nada depende de la función en `pg_depend` (ningún índice, CHECK ni vista): reemplazarla no
 *    deja nada que reindexar. Dueño: `postgres`.
 *
 * ── Qué hace ───────────────────────────────────────────────────────────────────────────────
 *  Reescribe la función con la MISMA semántica que se quiso (entero o decimal, con una `m` final
 *  opcional para moneda) y SIN UN SOLO SIGNO DE INTERROGACIÓN: `{0,1}` donde iba el cuantificador
 *  opcional, y `[.]` en lugar de la barra invertida (así tampoco depende de cómo escape la barra el
 *  template de JS). Mismas propiedades: LANGUAGE sql, IMMUTABLE, RETURNS numeric.
 *  `CREATE OR REPLACE` conserva el dueño y los permisos.
 *
 * ⚠️ Sólo reemplaza una función: `ops/prod/compuerta-migraciones.sh` no extrae objetos de un
 *    `CREATE FUNCTION`, así que mientras esté pendiente la clasifica NO_MEDIDO y FRENA el
 *    despliegue. Aplicala en prod con `apply-one-migration-prod.js` ANTES de desplegar el commit
 *    que la trae.
 *
 * La prueba: `test-newdb-caja-custodia.js` §6a llama la función con cada llave, y
 * `preparar-base-caja.js` la trae en `REGLAS_SOBRE_LO_QUE_LEE`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_denom_valor(k text) RETURNS numeric
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT CASE WHEN k ~ '^[0-9]+([.][0-9]+){0,1}m{0,1}$' THEN replace(k, 'm', '')::numeric END
    $fn$`);
  await knex.raw(`COMMENT ON FUNCTION finance.caos_denom_valor(text) IS
    '[CGA-A.55.1] Valor de una llave de denominación (500, 1000, 0.5m) o NULL si no es una llave. La regex usa {0,1} a propósito: knex convierte cada signo de interrogación en $1, $2 aunque no haya bindings (GOTCHAS §71).'`);
};

/**
 * ⚠️ NO restaura la definición anterior, a propósito: la anterior es la que corrompió knex
 * (`…)$1m$2$`) y volver a ella reintroduce el defecto. Deshacer esta migración deja la función
 * correcta; quien deshaga además `20261026110741` la borra con el `down` de ésa.
 */
exports.down = async function down(knex) {
  void knex;
};
