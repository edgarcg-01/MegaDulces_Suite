/**
 * Expone `skip_scoring` en la vista passthrough `public.daily_captures`.
 *
 * La migración 20260604150000 agregó `skip_scoring` a la TABLA real
 * `trade.daily_captures`, pero la vista `public.daily_captures` (lista de
 * columnas explícita) no se recreó → no exponía la columna. Efecto: el check
 * `knex.schema.hasColumn('daily_captures','skip_scoring')` del service resuelve
 * contra la vista, devuelve false, y la captura del vendedor NO persiste el flag
 * (la visita sin ponderación queda con skip_scoring=false). Funcionalmente el
 * scoring igual se salta (score_final_pct/config_version_id van NULL porque el
 * skip es DTO-driven), pero el flag explícito permite distinguir estas visitas
 * en reportes. Patrón conocido: agregar columna a tabla bajo vista passthrough
 * exige recrear la vista (ver feedback_fieldops_passthrough_views).
 *
 * CREATE OR REPLACE VIEW permite agregar columnas SOLO al final → seguro.
 * NOTA: la API cachea hasColumn con TTL negativo; requiere restart para que el
 * flag empiece a escribirse de inmediato (sino se re-chequea al expirar el TTL).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.raw(
    `SELECT 1 FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'daily_captures'
        AND a.attname = 'skip_scoring' AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  if (has.rows.length) return; // ya expuesta

  await knex.raw(`
    CREATE OR REPLACE VIEW public.daily_captures AS
    SELECT
      id, tenant_id, folio, user_id, store_id, fecha, hora_inicio, hora_fin,
      exhibiciones, stats, latitud, longitud, config_version_id, score_maximo,
      score_calidad_pct, score_cobertura_pct, score_final_pct, created_at,
      created_by, updated_at, updated_by, deleted_at, deleted_by, activo,
      captured_by_username, zona_captura, sync_uuid, route_id, skip_scoring
    FROM trade.daily_captures
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW public.daily_captures AS
    SELECT
      id, tenant_id, folio, user_id, store_id, fecha, hora_inicio, hora_fin,
      exhibiciones, stats, latitud, longitud, config_version_id, score_maximo,
      score_calidad_pct, score_cobertura_pct, score_final_pct, created_at,
      created_by, updated_at, updated_by, deleted_at, deleted_by, activo,
      captured_by_username, zona_captura, sync_uuid, route_id
    FROM trade.daily_captures
  `);
};
