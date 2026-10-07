/**
 * Independencia de módulos — batch de fugas sueltas (Trade): endpoints que pedían
 * el permiso de OTRO módulo se repuntaron al permiso de su módulo dueño. Backfill
 * para que nadie pierda acceso (target ← source donde source estaba en true):
 *
 *   - stores DELETE:        CATALOGO_GESTIONAR   → TIENDAS_CREAR
 *   - daily-captures DELETE: REPORTES_GESTIONAR  → VISITAS_AUDITAR
 *   - visits GET (listar):   REPORTES_VER_PROPIO → VISITAS_VER
 *
 * Semántica UPGRADE (no "fill-if-null"): TIENDAS_CREAR/VISITAS_AUDITAR/VISITAS_VER son
 * permisos estándar que YA existen (=false) en el JSONB de todo rol, así que un guard
 * `IS NULL` nunca dispararía y no preservaría acceso. Subimos false→true donde el origen
 * es true. Idempotente (si ya es true, el WHERE lo excluye), aditivo (no borra el viejo).
 * Re-login para el gating de UI; la autz backend es fresca (cache 30s).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const derived = [
    { key: 'TIENDAS_CREAR', from: 'CATALOGO_GESTIONAR' },
    { key: 'VISITAS_AUDITAR', from: 'REPORTES_GESTIONAR' },
    { key: 'VISITAS_VER', from: 'REPORTES_VER_PROPIO' },
  ];
  let total = 0;
  for (const d of derived) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object(:key::text, true)
        WHERE COALESCE((permissions->>:from::text)::boolean, false) = true
          AND COALESCE((permissions->>:key::text)::boolean, false) = false`,
      { key: d.key, from: d.from },
    );
    total += res.rowCount ?? 0;
  }
  console.log(`[trade_leaks_backfill_perms] up: filas actualizadas = ${total}`);
};

/**
 * No revierte valores (aditivo y condicionado). Down = no-op seguro: quitar las
 * claves borraría permisos que el rol pudo tener por otras vías. Idempotente.
 * @param { import("knex").Knex } _knex
 */
exports.down = async function (_knex) {
  console.log('[trade_leaks_backfill_perms] down: no-op (backfill aditivo condicionado)');
};
