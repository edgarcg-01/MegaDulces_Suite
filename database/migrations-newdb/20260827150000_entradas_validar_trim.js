'use strict';
/**
 * `[RE.13.6]` — Recorta `COMPRAS_ENTRADAS_VALIDAR` de los roles que **nadie usa**.
 *
 * De dónde viene el problema: la migración `20260811130000_compras_grant_full_to_holders`
 * concedió **los 21 permisos `COMPRAS_*`** a cualquier rol que tuviera alguno ("quien opera
 * Compras debe tener acceso a todos sus submódulos"). Razonable para los `*_VER`, pero
 * `_VALIDAR` no es un submódulo: es **quién aprueba la factura de un proveedor**, y el propio
 * controller lo documenta como "permiso especial restringido — que no todos validen". Quedó
 * en **15 roles**, incluidos `coordinadora_marketing`, `tele_operator` y `gestor_tesoreria`.
 *
 * Qué hace esta migración y qué NO:
 *   - **Sí**: quita `_VALIDAR` de los roles con **cero usuarios activos**. No afecta a ninguna
 *     persona (por definición) y baja la superficie del control. Medido en local:
 *     `cedis`, `contabilidad`, `prevencion_auditoria`, `sistemas`, `tele_operator`.
 *   - **No**: no toca los roles que **sí tienen gente**. A quién se le deja aprobar facturas es
 *     una decisión de control interno de Edgar, no del código; quitarle el permiso a una
 *     persona que hoy lo usa es romperle el trabajo sin avisar. Esos van en un segundo paso,
 *     con la lista aprobada. El insumo lo da `database/scripts/audit-entradas-access.js`.
 *
 * El conjunto se calcula **contra la DB donde corre**, no con una lista fija: un rol puede
 * tener usuarios en prod y no en local, y ahí lo correcto es no tocarlo.
 *
 * `_VER` y `_GESTIONAR` no se tocan: ver y capturar evidencia es inofensivo y es lo que hace
 * que el proceso arranque.
 *
 * Idempotente. **Cambia el JWT → los afectados necesitan re-login** (aunque por definición no
 * hay afectados con sesión activa: son roles sin usuarios).
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'COMPRAS_ENTRADAS_VALIDAR';
/** God-mode: `RolesGuard` los deja pasar igual, así que quitarles la clave sólo confunde. */
const PLATAFORMA = ['superadmin', 'admin'];

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT rp.role_name,
            (SELECT COUNT(*)::int FROM public.users u
              WHERE lower(u.role_name) = lower(rp.role_name) AND u.deleted_at IS NULL) AS usuarios
       FROM public.role_permissions rp
      -- Ojo: el operador '?' de JSONB lo rompe knex al escapar (gotcha del repo). Se usa ->>.
      WHERE COALESCE((rp.permissions->>'${PERM}')::boolean, false)
        AND lower(rp.role_name) NOT IN (${PLATAFORMA.map((r) => `'${r}'`).join(', ')})`,
  );

  const sinGente = rows.filter((r) => Number(r.usuarios) === 0).map((r) => r.role_name);
  const conGente = rows.filter((r) => Number(r.usuarios) > 0);

  if (sinGente.length) {
    await knex.raw(
      `UPDATE public.role_permissions
          SET permissions = jsonb_set(permissions, '{${PERM}}', 'false'::jsonb)
        WHERE role_name = ANY(?)`,
      [sinGente],
    );
    console.log(`[entradas_validar_trim] ${PERM} revocado en ${sinGente.length} rol(es) sin usuarios: ${sinGente.join(', ')}`);
  } else {
    console.log(`[entradas_validar_trim] no hay roles sin usuarios con ${PERM} — nada que recortar`);
  }

  if (conGente.length) {
    console.log(
      `[entradas_validar_trim] PENDIENTE de decisión (tienen gente, NO se tocan): ` +
      conGente.map((r) => `${r.role_name} (${r.usuarios})`).join(', '),
    );
  }
};

exports.down = async function down() {
  // No se re-concede: el estado previo era un grant masivo accidental, no una decisión.
  console.log('[entradas_validar_trim] down: no-op (no se re-concede un permiso de control)');
};
