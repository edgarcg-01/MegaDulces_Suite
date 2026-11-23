'use strict';
/**
 * `[RE.86]` — **Una factura (CFDI) puede ligarse a varias entradas, pero sólo con motivo** (Edgar, 2026-11-23:
 * «sí, hagámoslo que se liguen, pero sólo con motivo»).
 *
 * Kepler deja que varias entradas citen la misma factura (la referencia es texto) y pasa: la mercancía llega en
 * dos partes, o lo que faltó llega después (CEDIS 0010302 vuelve a cargar la caja que faltó de la GDL/319 de
 * PAF, que ya es de la 0010129). La Suite no lo podía decir: `fiscal.cfdi_assignments` tiene un índice único
 * por CFDI (una liga viva por factura), y la 0010302 quedaba en «Sin papel» pidiendo una remisión que no existe.
 *
 * El cambio, en la base y no en la buena voluntad del código:
 *  · `shared_reason` (texto, ≥ 10 caracteres): el motivo de una liga COMPARTIDA.
 *  · Los dos índices únicos por CFDI (`fiscal_cfdi_assign_cfdi_viva`, `ux_fiscal_cfdi_assign_confirmed`) pasan
 *    a valer sólo para las ligas SIN motivo: la segunda liga de una factura sólo entra si trae su porqué. La de
 *    una factura por OPERACIÓN (`fiscal_cfdi_assign_op_viva`) no cambia: una entrada sigue teniendo una factura.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-23) ──────────────────────────────────────────────────────────────
 *  · `fiscal.cfdi_assignments` tiene 0 filas: cambiar los índices no revalida nada ni toma candado largo.
 *  · 11 facturas citadas por más de una entrada en 90 días (22 entradas) — el caso que esto destraba.
 *  · Escriben la tabla: Materialidad (`materialidad-assignments.service.ts`: confirmar, rechazar, lote
 *    automático, deshacer). Ninguna escribe `shared_reason` → nace NULL y siguen 1:1 como hoy.
 *
 * Idempotente. Columna nueva y anulable: ningún camino de inserción existente se rompe.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'fiscal.cfdi_assignments';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('fiscal').hasColumn('cfdi_assignments', 'shared_reason'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN shared_reason text`);
  }
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS fiscal_cfdi_assign_shared_reason_check`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT fiscal_cfdi_assign_shared_reason_check
    CHECK (shared_reason IS NULL OR length(btrim(shared_reason)) >= 10)`);
  // Una liga SIN motivo sigue siendo la única viva de su CFDI; las ligas con motivo quedan fuera de la regla.
  await knex.raw(`DROP INDEX IF EXISTS fiscal.fiscal_cfdi_assign_cfdi_viva`);
  await knex.raw(`CREATE UNIQUE INDEX fiscal_cfdi_assign_cfdi_viva ON ${T} (tenant_id, cfdi_id)
    WHERE status IN ('confirmed', 'auto') AND shared_reason IS NULL`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.ux_fiscal_cfdi_assign_confirmed`);
  await knex.raw(`CREATE UNIQUE INDEX ux_fiscal_cfdi_assign_confirmed ON ${T} (tenant_id, cfdi_id)
    WHERE status = 'confirmed' AND shared_reason IS NULL`);
  // Para leer rápido «qué entradas comparten esta factura».
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fiscal_cfdi_assign_cfdi ON ${T} (tenant_id, cfdi_id)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Se niega si ya hay ligas compartidas vivas (perderían su regla). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM ${T} WHERE shared_reason IS NOT NULL AND status IN ('confirmed', 'auto')`);
  if (rows[0].n > 0) throw new Error(`[RE.86] down: hay ${rows[0].n} ligas compartidas vivas; desligarlas antes de deshacer.`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.ix_fiscal_cfdi_assign_cfdi`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.ux_fiscal_cfdi_assign_confirmed`);
  await knex.raw(`CREATE UNIQUE INDEX ux_fiscal_cfdi_assign_confirmed ON ${T} (tenant_id, cfdi_id) WHERE status = 'confirmed'`);
  await knex.raw(`DROP INDEX IF EXISTS fiscal.fiscal_cfdi_assign_cfdi_viva`);
  await knex.raw(`CREATE UNIQUE INDEX fiscal_cfdi_assign_cfdi_viva ON ${T} (tenant_id, cfdi_id) WHERE status IN ('confirmed', 'auto')`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS fiscal_cfdi_assign_shared_reason_check`);
  if (await knex.schema.withSchema('fiscal').hasColumn('cfdi_assignments', 'shared_reason')) {
    await knex.raw(`ALTER TABLE ${T} DROP COLUMN shared_reason`);
  }
};
