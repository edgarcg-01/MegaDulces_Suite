'use strict';
/**
 * `[CGA-A.55.1]` — `finance.caos_denom_valor()` vuelve a reconocer las denominaciones. En prod
 * devuelve NULL para TODA llave ('500', '1000', '20m', '0.5'…), así que el trigger
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
 *  Es la trampa de `docs/GOTCHAS.md` §71, por TERCERA vez (`[IG.0.1]` el 2026-09-25, `[CG.163]` el
 *  2026-10-15 y ésta): aquella migración ya advertía «ni un `?` en el SQL» y el `?` se coló en la
 *  regex.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-26) ───────────────────────────────────────
 *  · `caos_denom_valor` de las 12 llaves del catálogo (`libs/contracts/src/money/denominations.ts`:
 *    seis billetes '1000' … '20' y seis monedas '20m', '10', '5', '2', '1', '0.5') → NULL las doce.
 *    Son las mismas 12 que usa `finance.cash_ledger_denominations` (de '500' con 357 renglones a
 *    '20m' con 1).
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
 *    `CREATE FUNCTION` («objetos que crean: 0»), así que mientras esté pendiente la clasifica
 *    NO_MEDIDO y FRENA el despliegue de `main`: el de todo el equipo, no sólo el de este commit.
 *    Orden: mergear PRIMERO y, en seguida, aplicarla en prod con `ops/prod/aplicar-migracion.sh`
 *    (RUNBOOK-despliegue §3), antes del siguiente despliegue. ⛔ NO con `apply-one-migration-prod.js`
 *    antes de mergear: `[OPS.MIG]` (7b9f4e2fa, 2026-10-08) lo prohíbe, porque deja el
 *    `knex_migrations` de prod nombrando un archivo que la imagen no tiene y frena la siguiente
 *    migración de cualquiera. La plantilla de `scripts/nueva-migracion.js` todavía dice «antes de
 *    mergear»: contradicción declarada, para Edgar.
 *
 * La prueba: `test-newdb-caja-custodia.js` §6a llama la función con las 12 llaves del catálogo (las
 * lee del fuente), la cruza con `valorDeLlave` del motor TS y exige que ninguna función de
 * `finance` guarde `$N` dentro de una regex; `preparar-base-caja.js` la trae en
 * `REGLAS_SOBRE_LO_QUE_LEE`.
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
    '[CGA-A.55.1] Valor de una llave de denominación (500, 1000, 20m, 0.5) o NULL si no es una llave. La regex usa {0,1} a propósito: knex convierte cada signo de interrogación en $1, $2 aunque no haya bindings (GOTCHAS §71).'`);
};

/**
 * ⚠️ NO restaura la definición anterior, a propósito: la anterior es la que corrompió knex
 * (`…)$1m$2$`) y volver a ella reintroduce el defecto. Deshacer esta migración deja la función
 * correcta; quien deshaga además `20261026110741` la borra con el `down` de ésa.
 */
exports.down = async function down(knex) {
  void knex;
};
