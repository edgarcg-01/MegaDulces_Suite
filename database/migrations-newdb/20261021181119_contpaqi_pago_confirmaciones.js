'use strict';
/**
 * `[CP.8.73]` — **La confirmación humana de qué facturas paga un pago a proveedor.**
 *
 * El puente arma solo el pago a proveedor cuando sabe qué facturas y notas paga (la cadena de Kepler o una
 * factura por importe, `[CP.8.72]`). El resto queda «a confirmar»: una persona elige, entre las facturas y
 * notas abiertas del proveedor, las que paga ese movimiento, y el puente lo arma completo con ESO.
 *
 * ── Lo medido antes (sólo lectura, 2026-10-21) ──────────────────────────────────────────────
 *  · 767 de los 1,831 pagos a proveedor de 2026 quedan «a confirmar» sin el ADD (D8).
 *  · En 697 de 761 con respuesta de la contadora, sus facturas están TODAS entre las candidatas (91.6 %).
 *  · La sugerencia acierta exacto en 297 (39 %) — por eso no se aplica sola: hace falta esta tabla.
 *
 * Es dato PROPIO (decisión humana), no una copia: la regla 1 permite tabla real para HITL.
 * Molde: `contpaqi.supplier_aliases` (`[CP.8.36]`/`[CP.8.39]`) — RLS forzado, `app_runtime` lee y escribe.
 *
 * ⛔ `pagado` guarda el importe del movimiento AL CONFIRMAR: si el movimiento cambia después, la confirmación
 *    no se aplica a ciegas (el servicio la compara).
 * ⛔ Una sola confirmación vigente por movimiento (`active`); desconfirmar la apaga, no la borra.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'contpaqi.pago_confirmaciones';
const POLITICA = 'tenant_isolation';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = await knex.schema.withSchema('contpaqi').hasTable('pago_confirmaciones');
  if (!hay) {
    await knex.schema.withSchema('contpaqi').createTable('pago_confirmaciones', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      /** El egreso del banco que se confirma. */
      t.uuid('bank_movement_id').notNullable().references('id').inTable('finance.bank_movements');
      /** UUID de las facturas (CFDI I) que paga. Al menos una. */
      t.specificType('facturas', 'text[]').notNullable();
      /** UUID de las notas de crédito (CFDI E) que se aplican en el pago. */
      t.specificType('notas', 'text[]').notNullable().defaultTo('{}');
      /** Lo que salió del banco al confirmar: si el movimiento cambia, la confirmación no se aplica a ciegas. */
      t.decimal('pagado', 14, 2).notNullable();
      /** ⛔ NOT NULL: una confirmación sin autor no es una afirmación. */
      t.text('confirmado_por').notNullable();
      t.text('nota');
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by').notNullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
    });
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS pago_confirmaciones_una_vigente
      ON ${TABLA} (tenant_id, bank_movement_id) WHERE active`);
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE ${TABLA} ADD CONSTRAINT pago_confirmaciones_con_factura_chk CHECK (cardinality(facturas) >= 1);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE ${TABLA} ADD CONSTRAINT pago_confirmaciones_pagado_chk CHECK (pagado > 0);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await knex.raw(`
    COMMENT ON TABLE ${TABLA} IS
    '[CP.8.73] Que facturas y notas paga un pago a proveedor, confirmado por una PERSONA cuando el puente no '
    'lo resolvio solo. El armado lo usa en vez de adivinar; si las facturas menos las notas no dan lo pagado, '
    'no se guarda.'`);

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${POLITICA} ON ${TABLA}`);
  await knex.raw(`
    CREATE POLICY ${POLITICA} ON ${TABLA}
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${TABLA} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${TABLA} TO dev_ro`);

  /** ⛔ Freno de verdad: se comprueba el estado FINAL, no que el script haya corrido. */
  const { rows } = await knex.raw(`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forzado,
           (SELECT count(*)::int FROM pg_policies p
             WHERE p.schemaname = 'contpaqi' AND p.tablename = 'pago_confirmaciones') AS politicas,
           has_table_privilege('app_runtime', '${TABLA}', 'SELECT') AS ar_select,
           has_table_privilege('app_runtime', '${TABLA}', 'INSERT') AS ar_insert,
           has_table_privilege('app_runtime', '${TABLA}', 'UPDATE') AS ar_update,
           has_table_privilege('dev_ro', '${TABLA}', 'SELECT') AS dev_select
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'contpaqi' AND c.relname = 'pago_confirmaciones'`);
  const r = rows[0];
  if (!r || !r.rls || !r.forzado || r.politicas !== 1 || !r.ar_select || !r.ar_insert || !r.ar_update || !r.dev_select) {
    throw new Error(`[CP.8.73] la tabla o su defensa no quedaron puestas: ${JSON.stringify(r)}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.schema.withSchema('contpaqi').dropTableIfExists('pago_confirmaciones');
};
