'use strict';
/**
 * `[PRM.1]` — Rol base `promotor`: captura de Control de Caducidades, y NADA MÁS.
 *
 * ── Por qué (medido en prod, 2026-11-18, sólo lectura) ──────────────────────────────────────
 *  · El permiso de caducidades (`COMMERCIAL_EXPIRY_VER` / `_CAPTURAR`) **no vive en ningún grupo
 *    de `role-presets`**, así que ningún rol lo repartía: `commercial.promoter_brands` tiene 0 filas
 *    (0 promotoras en la Suite). Las ~79 promotoras de marca (zonas La Piedad / Morelia / Zamora)
 *    siguen capturando fuera de la Suite.
 *  · Darles `comercial` (o cualquier rol existente) sobre-otorga decenas de claves. Por ADR-054
 *    (el permiso es una CLAVE, no un paquete) el promotor lleva EXACTAMENTE las dos de caducidades.
 *
 * ── Qué deja ─────────────────────────────────────────────────────────────────────────────────
 *  · Rol `promotor` con 2 claves: `COMMERCIAL_EXPIRY_VER` + `COMMERCIAL_EXPIRY_CAPTURAR`.
 *  · Alcance (`identity.role_scopes`): `zone: own` (su zona, de `users.zona_id`) · `warehouse: all`.
 *    ⛔ `warehouse` NO puede ser `own`: la promotora no tiene `warehouse_code`, y `warehouseIds()`
 *    con `own` sin código devuelve `[]` = no ve NADA (fail-closed ya vivido). De todos modos el
 *    servicio de caducidades ya la acota a SUS hojas (`created_by = userId`) y su marca sale de
 *    `promoter_brands`. Resto de dimensiones `none`.
 *  · NO da de alta usuarios: el alta de las ~79 promotoras (con su zona, su marca y
 *    `must_change_password`) es un paso aparte, revisado antes de correrse.
 *
 * Sólo INSERT/UPSERT, sin objetos de esquema: la compuerta del despliegue la clasifica NO_MEDIDO y
 * frena hasta aplicarla — se aplica ANTES de soltar. Idempotente. Los permisos viajan en el JWT.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'promotor';
const CLAVES = ['COMMERCIAL_EXPIRY_VER', 'COMMERCIAL_EXPIRY_CAPTURAR'];
// La promotora no tiene sucursal: su eje es la ZONA. `warehouse: all` evita la ceguera del `own`
// sin código; el recorte real a sus hojas lo hace `created_by` en el servicio de caducidades.
const ALCANCE = { brand: 'none', customer: 'none', expense_area: 'none', route: 'none', warehouse: 'all', zone: 'own' };
const NOTA = '[PRM.1] Promotor de marca: caducidades de su marca en su zona (decisión de Edgar, 2026-11-18).';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: tenants } = await knex.raw(
    `SELECT id, slug FROM identity.tenants WHERE deleted_at IS NULL ORDER BY slug`,
  );
  if (!tenants.length) throw new Error('No hay tenants en identity.tenants.');
  const permisos = JSON.stringify(Object.fromEntries(CLAVES.map((k) => [k, true])));

  for (const t of tenants) {
    // El `kind` se toma de un rol base vivo (telemarketing) para no adivinar su CHECK; si no
    // hubiera, cae a 'area' (el valor de los roles de organigrama). El rol es PRIMARIO: la persona
    // lo lleva en `users.role_name`, así que no hace falta `user_roles`.
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions, kind)
       VALUES (
         ?, ?, ?::jsonb,
         COALESCE((SELECT kind FROM identity.role_permissions
                    WHERE tenant_id = ? AND role_name = 'telemarketing' LIMIT 1), 'area')
       )
       ON CONFLICT (tenant_id, role_name) DO UPDATE
         SET permissions = role_permissions.permissions || ?::jsonb, updated_at = now()`,
      [t.id, ROL, permisos, t.id, permisos],
    );
    for (const [dimension, mode] of Object.entries(ALCANCE)) {
      await knex.raw(
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, values, nota)
         VALUES (?, ?, ?, '*', ?, NULL, ?)
         ON CONFLICT (tenant_id, role_name, dimension, area) DO UPDATE
           SET mode = EXCLUDED.mode, values = NULL, updated_at = now()`,
        [t.id, ROL, dimension, mode, NOTA],
      );
    }
    console.log(`  ✓ [${t.slug}] rol ${ROL}: ${CLAVES.length} claves de caducidades; zona=own, almacén=all.`);
  }

  // ── Gates ─────────────────────────────────────────────────────────────────────────────────
  // (a) Las 2 claves OTORGADAS (true), no sólo presentes.
  const { rows: faltan } = await knex.raw(
    `SELECT t.slug, k FROM identity.tenants t CROSS JOIN unnest(?::text[]) k
      WHERE t.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM identity.role_permissions rp
         WHERE rp.tenant_id = t.id AND rp.role_name = ? AND rp.permissions -> k = 'true'::jsonb)`,
    [CLAVES, ROL],
  );
  if (faltan.length) throw new Error(`El rol ${ROL} quedó sin: ${faltan.map((r) => `${r.slug}/${r.k}`).join(', ')}`);
  // (b) Nada fuera de caducidades: si alguien le sumó otra clave a mano, se dice (no se borra).
  const { rows: extra } = await knex.raw(
    `SELECT DISTINCT e.k FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND NOT (e.k = ANY(?))`,
    [ROL, CLAVES],
  );
  if (extra.length) console.log(`  ⚠️ ${ROL} trae además (no esperado): ${extra.map((r) => r.k).join(', ')}`);
  // (c) El alcance quedó asentado.
  const { rows: scopes } = await knex.raw(
    `SELECT dimension, mode FROM identity.role_scopes WHERE role_name = ? AND area = '*' ORDER BY dimension`,
    [ROL],
  );
  console.log(`  Alcance de ${ROL}: ${scopes.map((s) => `${s.dimension}=${s.mode}`).join(', ')}`);
  // (d) Regla 20: hoy el rol existe pero nadie lo lleva — el alta de promotoras es el paso siguiente.
  const { rows: con } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.users WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  console.log(`  Usuarios con rol ${ROL}: ${con[0].n} (0 esperado hoy; el alta de las ~79 promotoras va aparte).`);
};

/** Vacía el rol y quita su alcance; conserva la fila por si alguien ya lo usa. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = '{}'::jsonb, updated_at = now() WHERE role_name = ?`, [ROL]);
  await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ? AND area = '*'`, [ROL]);
  console.log(`[PRM.1] ${ROL}: permisos vaciados y alcance retirado (la fila del rol se conserva).`);
};
