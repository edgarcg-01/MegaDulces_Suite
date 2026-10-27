'use strict';
/**
 * `[LE.0.0e]` — `finance.caos_denom_valor()` devuelve NULL para TODA denominación en prod, y con eso
 * la regla de `[CGA-A.55]` (los billetes de cada pedazo de un retiro) rechaza cualquier enlace que
 * traiga billetes con `CAOS_LINK_BILLETES_FORMA`.
 *
 * ── Lo medido antes (prod, sólo lectura, `7688376744939610156`, 2026-10-27 11:02) ────────────
 *  · `20261026110741_cga_a55` aplicada el 2026-10-26 12:37.
 *  · El cuerpo en prod es `k ~ '^[0-9]+(\.[0-9]+)$1m$2$'`: knex convirtió los dos `?` de la
 *    expresión regular en parámetros `$1` y `$2` (GOTCHAS: «ni un `?` en el SQL»).
 *  · `caos_denom_valor('500')` = NULL · `caos_denom_valor('0.5m')` = NULL.
 *  · 0 de 121 enlaces vivos traen billetes: la pantalla todavía no los manda, así que nadie está
 *    fallando hoy. El defecto está DORMIDO, pero la regla no protege nada y deja rojo el job
 *    `caja-db` (`test-newdb-caja-custodia.js` §6b: 2 ✗, también sin ningún cambio de LE).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  La misma expresión con `{0,1}` en lugar de `?`, y se COMPRUEBA a sí misma al aplicar: cada llave
 *  del catálogo (`libs/contracts/src/money/denominations.ts`) da su valor y una llave inválida da
 *  NULL. Si no, aborta: no se repite el error de quedar aplicada y rota.
 *
 * Idempotente (`CREATE OR REPLACE`).
 *
 * @param { import("knex").Knex } knex
 */

/** Las llaves de `DENOMINACIONES_MXN` con su valor (billetes, y monedas con `m` donde chocan). */
const CATALOGO = { 1000: 1000, 500: 500, 200: 200, 100: 100, 50: 50, 20: 20, '20m': 20, 10: 10, 5: 5, 2: 2, 1: 1, '0.5': 0.5 };
const INVALIDAS = ['500x', 'm', '', '-20', '1.', 'b500'];

const cuerpo = (regex) => `
  CREATE OR REPLACE FUNCTION finance.caos_denom_valor(k text) RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE WHEN k ~ '${regex}' THEN replace(k, 'm', '')::numeric END
  $fn$`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(cuerpo('^[0-9]+(\\.[0-9]+){0,1}m{0,1}$'));

  const llaves = [...Object.keys(CATALOGO), ...INVALIDAS];
  const lista = llaves.map((k) => `('${k}')`).join(', ');
  const { rows } = await knex.raw(`SELECT k, finance.caos_denom_valor(k)::float8 AS v FROM (VALUES ${lista}) t(k)`);
  const malas = rows.filter((r) => (r.k in CATALOGO ? r.v !== CATALOGO[r.k] : r.v !== null));
  if (malas.length) {
    throw new Error(`[LE.0.0e] caos_denom_valor sigue mal: ${malas.map((r) => `${r.k}→${r.v}`).join(', ')}`);
  }
  console.log(`  ✓ [LE.0.0e] caos_denom_valor: ${Object.keys(CATALOGO).length} llaves del catálogo con su valor, ${INVALIDAS.length} inválidas en NULL`);
};

/** Vuelve al cuerpo de `20261026110741` TAL COMO QUEDÓ en prod (roto): deshacer es eso. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(cuerpo('^[0-9]+(\\.[0-9]+)$1m$2$'));
};
