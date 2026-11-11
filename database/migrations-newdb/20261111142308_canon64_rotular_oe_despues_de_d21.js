'use strict';
/**
 * `[CANON.6.4]` — Rotula las recepciones (OE) que `import-auto-received.js` creó DESPUÉS de D21.
 *
 * D21 (`[PQ.16]`, commit `87e8adc93`, 2026-10-26 17:07): la Suite deja de emitir OC y recepciones
 * propias; las suyas quedan congeladas y la recepción es la X-A-40 de Kepler, que se lee. El script
 * nocturno siguió corriendo y casó entradas de Kepler contra esas OC congeladas por PRESENCIA de SKU.
 * Edgar (2026-11-11): «rotula» — no se borran ni se revierten (regla 5); se dice qué son.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-11) ────────────────────────────────────────
 *  · 158 OE `source='kepler'` creadas después del corte, sobre 80 OC (11,232 unidades), de la
 *    corrida del 27-oct 03:04 a la del 11-nov 03:04; las 158 con la nota estándar
 *    «Auto-conciliado X-A-40 <folio>». 56 casaron una entrada de más de 14 días después de su OC.
 *  · La tabla no tiene `updated_at`; RLS forzado (se fija el tenant en la transacción).
 *
 * Qué hace: agrega al final de `notes` un rótulo fijo. Sólo a las que no lo tienen (idempotente);
 * si el carril corrió otra vez antes de aplicarla, también rotula esas (mismo criterio).
 * El `down` quita exactamente ese rótulo.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y frena a todos hasta
 *    aplicarla. Se aplica en cuanto llegue a `origin/main`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CORTE_D21 = '2026-10-26T17:07:00-06:00';
const ROTULO =
  ' · ⚠️ Creada DESPUÉS de D21 (PQ.16, 26-oct-2026): la Suite ya no emite recepciones; el carril auto-received la casó por presencia de SKU contra una OC congelada. No verificada contra Kepler.';

exports.ROTULO = ROTULO;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  const r = await knex.raw(
    `UPDATE commercial.goods_receipts
        SET notes = COALESCE(notes, '') || ?
      WHERE tenant_id = ?::uuid AND source = 'kepler' AND created_at > ?::timestamptz
        AND position(? IN COALESCE(notes, '')) = 0`,
    [ROTULO, TENANT, CORTE_D21, ROTULO],
  );
  const t = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.goods_receipts
      WHERE tenant_id = ?::uuid AND source = 'kepler' AND created_at > ?::timestamptz AND position(? IN COALESCE(notes, '')) > 0`,
    [TENANT, CORTE_D21, ROTULO],
  );
  console.log(`[CANON.6.4] rotuladas ahora: ${r.rowCount} · con rótulo en total: ${t.rows[0].n} (medido antes: 158)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  const r = await knex.raw(
    `UPDATE commercial.goods_receipts
        SET notes = NULLIF(replace(notes, ?, ''), '')
      WHERE tenant_id = ?::uuid AND source = 'kepler' AND position(? IN COALESCE(notes, '')) > 0`,
    [ROTULO, TENANT, ROTULO],
  );
  console.log(`[CANON.6.4] rótulo quitado de ${r.rowCount} OE`);
};
