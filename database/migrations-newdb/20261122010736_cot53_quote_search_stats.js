'use strict';
/**
 * `[COT.53]` — **Qué se busca en el cotizador y qué se elige, anónimo y agregado.** Tabla nueva
 * `commercial.quote_search_stats`.
 *
 * Por qué (punto 1 de la auditoría de uso y ML de Cotizaciones, 2026-11-21): para que el buscador
 * aprenda —sinónimos, poner primero lo que se elige— hace falta saber qué se escribió y qué se
 * eligió, y hoy no se guarda nada.
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · `GET /commercial/quotes/catalog`: 50,855 búsquedas en 42 días, ~5.5 por renglón guardado.
 *  · «¿Quisiste decir…?» (se pide cuando una búsqueda no trajo nada): 982 en sus primeros 5 días.
 *  · Ningún registro de término → artículo elegido.
 *
 * ── Anónimo, por decisión (Francisco, 2026-11-22) ────────────────────────────────────────────
 * La telemetría de la Suite declara que NO guarda lo que la persona escribe en el buscador. Esta
 * tabla tampoco guarda QUIÉN: ni `user_id` ni `created_by`, a propósito (la excepción a la regla
 * 18 de audit fields es la decisión). Es un CONTADOR por día · sucursal · término · artículo
 * elegido · posición. `chosen_sku = ''` y `position = 0` = la búsqueda no trajo nada.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS commercial`);
  if (!(await knex.schema.withSchema('commercial').hasTable('quote_search_stats'))) {
    await knex.raw(`
      CREATE TABLE commercial.quote_search_stats (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        day         date NOT NULL,
        branch      text NOT NULL CHECK (length(btrim(branch)) > 0),
        term        text NOT NULL CHECK (length(term) BETWEEN 1 AND 80),
        chosen_sku  text NOT NULL DEFAULT '',
        position    smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
        results     smallint NOT NULL DEFAULT 0 CHECK (results >= 0),
        times       integer NOT NULL DEFAULT 1 CHECK (times > 0),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT quote_search_stats_eligio_con_posicion CHECK ((chosen_sku = '') = (position = 0))
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_quote_search_stats_clave
                    ON commercial.quote_search_stats (tenant_id, day, branch, term, chosen_sku, position)`);
  await knex.raw(`ALTER TABLE commercial.quote_search_stats ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.quote_search_stats FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='quote_search_stats' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON commercial.quote_search_stats
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON commercial.quote_search_stats TO app_runtime;
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON TABLE commercial.quote_search_stats IS
    '[COT.53] Contador ANONIMO de busquedas del cotizador: por dia, sucursal, termino, articulo elegido y su posicion. Sin usuario a proposito (decision 2026-11-22). chosen_sku vacio y position 0 = la busqueda no trajo nada.'`);
  console.log('  ✓ [COT.53] commercial.quote_search_stats lista (RLS forzada, SELECT/INSERT/UPDATE para app_runtime, sin columnas de usuario)');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: la tabla es nueva. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.quote_search_stats`);
};
