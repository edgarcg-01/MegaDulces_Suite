'use strict';
/**
 * `[CANON.6.11]` — `analytics.hop2_fallas`: la falla DEFINITIVA de un normalizador del hop-2, escrita por el
 * propio hop-2 en el momento en que pasa. La alarma por EVENTO, sin barrido que la busque.
 *
 * Por qué: desde CANON.6.8–6.10 markup, promo y nombres los mantiene el hop-2 al llegar el cambio de Kepler,
 * y un normalizador que falla se reintenta partiendo el lote (`reintentarPorPartes`). Lo que SIGUE fallando
 * quedaba sólo en el log del pod — que se pierde en cada reinicio (así se perdió la causa del 9-nov, anexo
 * CANON §8.8, 9.4). Aquí queda como dato: qué tabla, qué normalizador, qué llaves y con qué error. El sensor
 * `hop2_fallas` de `db-health` lo lleva a la bandeja (el escáner sólo LEE esta tabla; no compara nada).
 *
 * ── Lo medido antes (sólo lectura, 2026-11-12) ────────────────────────────────────────────────
 *  · registro de los carriles `ods-live-*` desde el reinicio del 11-nov: 0 fallas «lo toma el barrido»;
 *    se espera que esta tabla crezca de a pocas filas, sólo cuando algo falla de verdad.
 *
 * Datos PROPIOS (un registro de nuestro proceso), no una copia de Kepler. `tenant_id` + RLS forzada
 * (`tenant_isolation`) + auditoría; `app_runtime` lee y escribe, `dev_ro` lee. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'analytics.hop2_fallas';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('CREATE SCHEMA IF NOT EXISTS analytics');
  if (!(await knex.schema.withSchema('analytics').hasTable('hop2_fallas'))) {
    await knex.schema.withSchema('analytics').createTable('hop2_fallas', (t) => {
      t.bigIncrements('id').primary();
      t.uuid('tenant_id').notNullable();
      /** Tabla del ODS cuyo cambio disparó el normalizador (p. ej. `kdpv_prod_util`). */
      t.text('tabla').notNullable();
      /** Normalizador que falló (p. ej. `normalizeMarkup`). */
      t.text('normalizador').notNullable();
      /** Las llaves (SKUs) que siguieron fallando después de reintentar por partes. */
      t.specificType('llaves', 'text[]').notNullable();
      /** De cuántas llaves era el lote original. */
      t.integer('llaves_lote').notNullable();
      t.text('error');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS hop2_fallas_recientes ON ${TABLA} (tenant_id, created_at DESC)`);
  await knex.raw(`COMMENT ON TABLE ${TABLA} IS
    '[CANON.6.11] Falla definitiva de un normalizador del hop-2 (services/feeds-ingest), escrita en el momento por el propio hop-2: la alarma por evento. La lee el sensor hop2_fallas de db-health.'`);

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA}`);
  await knex.raw(`CREATE POLICY tenant_isolation ON ${TABLA} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      EXECUTE 'GRANT SELECT, INSERT ON ${TABLA} TO app_runtime';
      EXECUTE 'GRANT USAGE ON SEQUENCE analytics.hop2_fallas_id_seq TO app_runtime';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${TABLA} TO dev_ro'; END IF;
  END $$`);

  // ⛔ Freno de verdad: el estado FINAL, no que las sentencias corrieron.
  const { rows: [e] } = await knex.raw(`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forzado,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'analytics' AND p.tablename = 'hop2_fallas') AS politicas
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'hop2_fallas'`);
  if (!e || !e.rls || !e.forzado || e.politicas < 1) {
    throw new Error(`[CANON.6.11] ${TABLA} quedó sin RLS forzada o sin política: ${JSON.stringify(e)}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS ${TABLA}`);
};
