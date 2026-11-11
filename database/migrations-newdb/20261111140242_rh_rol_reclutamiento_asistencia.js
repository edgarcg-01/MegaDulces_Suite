'use strict';
/**
 * `[RH.2.4]` — Rol complemento `reclutamiento_asistencia`: el acceso de RH a la Suite, SÓLO con lo de RH.
 *
 * ── Por qué (medido en prod, 2026-11-11, sólo lectura) ─────────────────────────────────────
 *  · Nadie de RH podía entrar a `/rh/*`: el rol `recursos_humanos` tenía 1 persona y ninguna de RH.
 *    Por eso RH siguió trabajando en Mega Talento después del corte de reclutamiento (10-nov): ese
 *    día y el siguiente registró allá llamadas y cambios de etapa que la Suite no recibe.
 *  · `recursos_humanos` trae **38 claves**, entre ellas aprobar y pagar comisiones, alta de clientes
 *    y áreas de gasto. Darlo tal cual era dar mucho más que RH.
 *  · Lesly Berber y Tania Solorio (administradoras de Mega Talento) ya tienen cuenta en la Suite con
 *    el perfil base `administrativo`. Edgar decidió (2026-11-11): rol nuevo sólo de RH, como
 *    COMPLEMENTO — conservan lo que ya tienen (`[ID.13]`: los permisos efectivos son la unión).
 *
 * ── Qué deja ─────────────────────────────────────────────────────────────────────────────────
 *  · Rol `reclutamiento_asistencia` (kind `complemento`) con las 8 claves de operar RH: reclutamiento
 *    (ver y gestionar) y asistencia (ver, gestionar, capturar y calificar incidencias, cerrar la
 *    semana, relojes). NO lleva `HR_INCIDENTS_AUDITAR` (es de Contabilidad: quien califica no audita,
 *    `[RH.1.6]`) ni `HR_ATTENDANCE_CHECAR` (es del kiosco). Alcance: todas las plazas y zonas; ni
 *    clientes, ni marcas, ni rutas, ni áreas de gasto.
 *  · El complemento a `lesly_berber` y `tania_solorio` (`identity.user_roles`, `is_primary=false`).
 *    Su perfil base no se toca.
 *
 * Sólo INSERT/UPSERT, sin objetos de esquema: la compuerta del despliegue la clasifica NO_MEDIDO y
 * frena hasta aplicarla — se aplica ANTES de soltar. Idempotente. Los permisos viajan en el JWT:
 * las dos deben volver a entrar.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'reclutamiento_asistencia';
const CLAVES = [
  'HR_RECRUITMENT_VER', 'HR_RECRUITMENT_GESTIONAR',
  'HR_ATTENDANCE_VER', 'HR_ATTENDANCE_GESTIONAR',
  'HR_INCIDENTS_CAPTURAR', 'HR_INCIDENTS_CALIFICAR', 'HR_PERIOD_CLOSE', 'HR_DEVICES_GESTIONAR',
];
const ALCANCE = { brand: 'none', customer: 'none', expense_area: 'none', route: 'none', warehouse: 'all', zone: 'all' };
const PERSONAS = ['lesly_berber', 'tania_solorio'];
const NOTA = '[RH.2.4] RH en la Suite: complemento sólo de RH (decisión de Edgar, 2026-11-11).';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: tenants } = await knex.raw(`SELECT id, slug FROM identity.tenants WHERE deleted_at IS NULL ORDER BY slug`);
  if (!tenants.length) throw new Error('No hay tenants en identity.tenants.');
  const permisos = JSON.stringify(Object.fromEntries(CLAVES.map((k) => [k, true])));

  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions, kind)
       VALUES (?, ?, ?::jsonb, 'complemento')
       ON CONFLICT (tenant_id, role_name) DO UPDATE
         SET permissions = role_permissions.permissions || ?::jsonb, updated_at = now()`,
      [t.id, ROL, permisos, permisos],
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
    // El complemento sólo donde la persona existe en ese tenant; su perfil base no se toca.
    const { rows: dadas } = await knex.raw(
      `INSERT INTO identity.user_roles (tenant_id, user_id, role_name, is_primary, nota)
       SELECT u.tenant_id, u.id, ?, false, ?
         FROM identity.users u
        WHERE u.tenant_id = ? AND u.username = ANY(?) AND u.deleted_at IS NULL
       ON CONFLICT (tenant_id, user_id, role_name) DO NOTHING
       RETURNING user_id`,
      [ROL, NOTA, t.id, PERSONAS],
    );
    console.log(`  ✓ [${t.slug}] rol ${ROL}: ${CLAVES.length} claves de RH; complemento nuevo a ${dadas.length} persona(s).`);
  }

  // ── Gates ─────────────────────────────────────────────────────────────────────────────────
  // (a) Las 8 claves OTORGADAS (true), no sólo presentes.
  const { rows: faltan } = await knex.raw(
    `SELECT t.slug, k FROM identity.tenants t CROSS JOIN unnest(?::text[]) k
      WHERE t.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM identity.role_permissions rp WHERE rp.tenant_id = t.id AND rp.role_name = ? AND rp.permissions -> k = 'true'::jsonb)`,
    [CLAVES, ROL],
  );
  if (faltan.length) throw new Error(`El rol ${ROL} quedó sin: ${faltan.map((r) => `${r.slug}/${r.k}`).join(', ')}`);
  // (b) Nada fuera de RH: si alguien le sumó otra clave a mano, se dice (no se borra).
  const { rows: extra } = await knex.raw(
    `SELECT DISTINCT e.k FROM identity.role_permissions rp, jsonb_each(rp.permissions) e(k, v)
      WHERE rp.role_name = ? AND v = 'true'::jsonb AND NOT (e.k = ANY(?))`,
    [ROL, CLAVES],
  );
  if (extra.length) console.log(`  ⚠️ ${ROL} trae además: ${extra.map((r) => r.k).join(', ')}`);
  // (c) Regla 20: el permiso REPARTIDO. Cuenta quién lo tiene, por nombre de usuario.
  const { rows: con } = await knex.raw(
    `SELECT u.username, u.role_name AS perfil_base FROM identity.user_roles ur JOIN identity.users u ON u.id = ur.user_id
      WHERE ur.role_name = ? ORDER BY 1`,
    [ROL],
  );
  console.log(`  Con ${ROL}: ${con.map((r) => `${r.username} (base ${r.perfil_base})`).join(', ') || 'NADIE'} — deben volver a entrar.`);
  const faltanPersonas = PERSONAS.filter((p) => !con.some((r) => r.username === p));
  if (faltanPersonas.length) console.log(`  ⚠️ Sin cuenta en este destino (no se les dio): ${faltanPersonas.join(', ')}`);
};

/** Quita el complemento a las personas y vacía el rol (la fila se conserva por si alguien más lo usa). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DELETE FROM identity.user_roles WHERE role_name = ? AND nota = ?`, [ROL, NOTA]);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = '{}'::jsonb, updated_at = now() WHERE role_name = ?`, [ROL]);
  await knex.raw(`DELETE FROM identity.role_scopes WHERE role_name = ? AND area = '*'`, [ROL]);
  console.log(`[RH.2.4] ${ROL}: complementos retirados y rol vaciado.`);
};
