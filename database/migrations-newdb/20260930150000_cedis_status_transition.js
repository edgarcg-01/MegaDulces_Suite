/* eslint-disable */
/**
 * `[IC.CEDIS.3]` — **El punto 4 del checklist de `FASE_IC_INVENTARIO_CONTINUO.md` §1.11c**, que
 * `20260930140000` dejó abierto: `wincaja.branches` `00` → `status` de `live_on_wincaja` a
 * `transition`.
 *
 * ── POR QUÉ NO ES COSMÉTICO ────────────────────────────────────────────────────────────────────
 * Tras la migración anterior la fila del CEDIS quedó **contradiciéndose a sí misma**: dice
 * `live_on_wincaja` y al mismo tiempo `kepler_cutover_date = 2026-09-30`. Y `status` no es un
 * rótulo: hay código que lo LEE para decidir. Medido hoy, `00` es la **única** fila que queda en
 * `live_on_wincaja` (las otras 4 que migraron ya están en `transition`).
 *
 * ── A QUIÉN LE PEGA, MEDIDO UNO POR UNO (no asumido) ───────────────────────────────────────────
 *  · `existencia.service.ts:589` — **el único predicado vivo en todo el repo**. Arma la píldora de
 *    frescura "Wincaja <ramas>" de la pantalla de Existencia a partir de las ramas que todavía se
 *    alimentan de un `.mdb`. Con `00` en `live_on_wincaja` esa píldora seguiría envejeciendo para
 *    siempre — y encima **rotula un dato que esa pantalla ni siquiera muestra**: medido,
 *    `analytics.v_erp_stock_on_hand` sólo trae 01-08 (todas `kepler_ods`), el CEDIS NO está ahí.
 *    Es exactamente el defecto que el comentario de ese mismo archivo describe para la rama '30':
 *    *"la etiqueta decía Wincaja y el minutero contaba una rama muerta"*. Con el cambio, el
 *    `if (w && w.dato_al)` que ya está escrito hace desaparecer la píldora sola. Cero código nuevo.
 *  · `db-health.service.ts:671` (`wincaja_existencias_entrega`) — **ya estaba RETIRADA el 09-19**,
 *    así que no se entera y no hay falso rojo. Se verificó en el archivo, no se supuso.
 *  · `movement-reconcile.service.ts:97,612` — sólo texto (descripción de una regla y un comentario),
 *    **ningún predicado**.
 *  · `wincaja-hist-config.js` — ranking de carga histórica, espejo a mano y fuera del camino vivo.
 *
 * ── POR QUÉ `transition` Y NO `legacy_on_kepler` ───────────────────────────────────────────────
 * Es el mismo valor que recibieron las otras cuatro el día de SU corte (10, 30, 32, 50 están todas
 * en `transition`, con `legacy_on_kepler` reservado a las 6 sucursales viejas de `-infinity`).
 * Copiar lo que ya se hizo cuatro veces le gana a estrenar un estado para un caso.
 *
 * ⚠️ Lo que esta migración NO toca, por tercera vez y a propósito: `wincaja_source_branch` y
 * `kepler_cutover_date` **son el puente al histórico**. Cambiar `status` no mueve el resolvedor
 * `analytics.v_branch_erp_cutover`, que filtra por `kepler_code` + `kepler_cutover_date`.
 */
exports.up = async function up(knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';

  const has = await knex.schema.withSchema('wincaja').hasTable('branches');
  if (!has) return;

  // Acotada y condicionada: sólo la fila del CEDIS, y sólo si ya declaró su corte. Sin ese
  // `whereNotNull` esto podría apagar una rama que todavía vende por Wincaja.
  await knex('wincaja.branches')
    .where({ tenant_id: TENANT, source_branch: '00', status: 'live_on_wincaja' })
    .whereNotNull('kepler_cutover_date')
    .update({ status: 'transition' });
};

exports.down = async function down(knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';
  const has = await knex.schema.withSchema('wincaja').hasTable('branches');
  if (!has) return;
  await knex('wincaja.branches')
    .where({ tenant_id: TENANT, source_branch: '00' })
    .update({ status: 'live_on_wincaja' });
};
