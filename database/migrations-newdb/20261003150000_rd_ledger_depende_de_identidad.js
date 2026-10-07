'use strict';
/**
 * `[RD.16]` — **Que el ledger DEPENDA de la identidad, en vez de sólo ir después.**
 *
 * ── El defecto ──────────────────────────────────────────────────────────────────────────────
 * `mv_rd_route_identity` y `mv_rd_route_ledger` leían **las dos la vista viva**. Se refrescan en
 * el mismo ciclo y la identidad va primero en el registro, así que *en la práctica* salían
 * coherentes — pero nada lo garantizaba: entre un `REFRESH` y el otro puede entrar una ruta, y
 * entonces una copia la tiene y la otra no. Es exactamente *ordenar no es depender* (ADR-056),
 * la trampa que VP.1 midió en el sell-out.
 *
 * ⛔ Y el registro de matvistas de 30 min **no tiene `deps`**: ese mecanismo existe sólo en el
 * grupo nocturno. Así que declarar la dependencia en el orquestador no era una opción.
 *
 * ── El arreglo, que es estructural y más fuerte que un orden ─────────────────────────────────
 * `v_rd_route_ledger` pasa a leer **`analytics.mv_rd_route_identity`** en vez de la vista. Con
 * eso la membresía del ledger **sale siempre de una foto coherente** de la identidad, se
 * refresque en el orden que se refresque:
 *
 *     invariante nueva:  rutas(ledger) ⊆ rutas(identidad)   — SIEMPRE
 *
 * O sea: **no puede haber números sin su fila**. Lo contrario —una ruta recién nacida que sale
 * en cero durante un ciclo, hasta que el ledger la alcance— sí puede pasar, es benigno (el LEFT
 * JOIN da ceros, no un error), se cura solo en ≤30 min, y el candado lo vigila.
 *
 * ⚠️ **Efecto lateral que hay que decir:** la vista "viva" deja de serlo del todo — su membresía
 * es la del último refresco de la identidad (≤30 min). El dato de movimiento sigue al momento.
 * Es el precio de la coherencia, y se paga a sabiendas.
 *
 * ⚠️ Esto **debilita a medias** la paridad del candado (las dos copias comparten ahora la misma
 * identidad), así que el candado suma la aserción de la invariante de arriba, que es lo que de
 * verdad importa vigilar.
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';

exports.up = async function up(knex) {
  const def = (await knex.raw(
    `SELECT pg_get_viewdef(?::regclass, true) AS d`, [LEDGER])).rows[0].d;
  if (def.includes('mv_rd_route_identity')) {
    console.log('  [RD.16] el ledger ya depende de la matvista de identidad');
    return;
  }
  // `CREATE OR REPLACE` conserva la lista de columnas, así que la matvista que cuelga de esta
  // vista no se invalida. Sólo cambia DE DÓNDE sale la membresía.
  const nueva = def.replace(/analytics\.v_rd_route_identity/g, 'analytics.mv_rd_route_identity');
  if (nueva === def) throw new Error('no se encontró la referencia a v_rd_route_identity en el ledger');
  await knex.raw(`CREATE OR REPLACE VIEW ${LEDGER} AS ${nueva}`);
  // ⚠️ No se heredan en un CREATE OR REPLACE — ADR-057 los perdió una vez justo así.
  await knex.raw(`ALTER VIEW ${LEDGER} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${LEDGER} IS
    'RD.16 - la membresia sale de analytics.mv_rd_route_identity (no de la vista) para que rutas(ledger) sea SIEMPRE un subconjunto de rutas(identidad): no puede haber numeros sin su fila. El movimiento sigue al momento; la membresia es la del ultimo refresco (<=30 min).'`);
};

exports.down = async function down(knex) {
  const def = (await knex.raw(
    `SELECT pg_get_viewdef(?::regclass, true) AS d`, [LEDGER])).rows[0].d;
  const vieja = def.replace(/analytics\.mv_rd_route_identity/g, 'analytics.v_rd_route_identity');
  await knex.raw(`CREATE OR REPLACE VIEW ${LEDGER} AS ${vieja}`);
  await knex.raw(`ALTER VIEW ${LEDGER} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO app_runtime`);
};
