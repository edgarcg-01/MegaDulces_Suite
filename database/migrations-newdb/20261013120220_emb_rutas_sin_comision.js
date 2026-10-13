'use strict';
/**
 * `[EMB.33]` — Una ruta puede NO pagar comisión: `logistics.routes.sin_comision`. Así una guía de
 * un traslado local se completa con comisión $0 (sólo viáticos y cargadores), en vez de quedarse
 * trabada con «Falta la tarifa de …» para siempre.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-13) ───────────────────────────────────────
 *  · En la catorcena 11–24 sep (pagada el 25-sep) el chofer de CEDIS con más viajes hizo 93 (La
 *    Piedad, Santa Ana Pacueco, Morelia…) y cobró $954 de comisión: ~$10 por viaje. Los cinco
 *    choferes que sólo van a Santa Ana Pacueco (10–12 viajes cada uno) NO aparecen en los pagos
 *    de comisión (concepto 075). O sea: los traslados locales no pagan comisión por viaje.
 *  · Las 3 rutas locales están en $0/$0 y una ruta en $0 cuenta como «sin tarifa» y frena la
 *    guía: SANTA ANA PACUECO (R0024, 811 viajes en 90 días), LA PIEDAD (323) y SANTA ANA (R25, 36).
 *  · Decisión del usuario (2026-10-13): «locales sin comisión».
 *
 * Se marcan por NOMBRE normalizado, las 3 y sólo si siguen en $0/$0: si alguien ya les puso
 * tarifa, se respeta. Cada marca queda en `logistics.tariff_changes` (EMB.28.1).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[emb_rutas_sin_comision]';
const LOCALES = ['SANTA ANA PACUECO', 'SANTA ANA', 'LA PIEDAD'];
const NORMALIZA = `trim(regexp_replace(upper(translate(r.name,'ÁÉÍÓÚÜÑáéíóúüñ','AEIOUUNaeiouun')),'[^A-Z0-9]+',' ','g'))`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('logistics').hasColumn('routes', 'sin_comision'))) {
    await knex.raw(`ALTER TABLE logistics.routes ADD COLUMN sin_comision boolean NOT NULL DEFAULT false`);
  }
  await knex.raw(`COMMENT ON COLUMN logistics.routes.sin_comision IS
    'EMB.33 — La ruta no paga comisión (traslado local): la guía se completa con comisión $0 y sólo cobra viáticos y cargadores. Una ruta en $0 SIN esta marca sigue contando como «sin tarifa». Cambiarla en una ruta fijada exige LOGISTICS_TARIFAS_AUTORIZAR.'`);

  const { rows } = await knex.raw(
    `UPDATE logistics.routes r SET sin_comision = true, updated_at = now()
      WHERE r.deleted_at IS NULL AND NOT r.sin_comision
        AND COALESCE(r.driver_commission, 0) = 0 AND COALESCE(r.helper_commission, 0) = 0
        AND ${NORMALIZA} = ANY(?::text[])
      RETURNING r.id, r.tenant_id, r.name`,
    [LOCALES],
  );
  for (const r of rows) {
    await knex.raw(
      `INSERT INTO logistics.tariff_changes (tenant_id, entity, entity_id, entity_label, field, old_value, new_value, autorizado, changed_by_username)
       VALUES (?, 'route', ?, ?, 'sin_comision', 'false', 'true', true, 'migración EMB.33')`,
      [r.tenant_id, r.id, r.name],
    );
  }
  console.log(`${TAG} marcadas sin comisión: ${rows.map((r) => r.name).join(', ') || '(ninguna)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DELETE FROM logistics.tariff_changes WHERE field = 'sin_comision' AND changed_by_username = 'migración EMB.33'`);
  if (await knex.schema.withSchema('logistics').hasColumn('routes', 'sin_comision')) {
    await knex.raw(`ALTER TABLE logistics.routes DROP COLUMN sin_comision`);
  }
};
