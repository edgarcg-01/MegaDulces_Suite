'use strict';
/**
 * Fase UN.4 — Revoca los 25 permisos de Finanzas/Fiscal de los roles operativos.
 *
 * QUÉ PASÓ (causa raíz trazada). `20260706170000_finance_expenses_perm_backfill`
 * ancló `FINANCE_EXPENSES_VER <- COMMERCIAL_ANALYTICS_VER`. `COMMERCIAL_ANALYTICS_VER`
 * es un permiso benigno de lectura que TODOS los roles operativos tienen, así que
 * el ancla regaló Finanzas a todo el mundo. De ahí en adelante cada módulo nuevo
 * se ancló al anterior — `20260722180000_finance_bank_perms` ancla
 * `FINANCE_BANK_GESTIONAR <- FINANCE_FINDINGS_GESTIONAR` "para que NINGÚN rol
 * pierda acceso" — y la fuga se propagó módulo por módulo hasta 25 permisos.
 * Cada migración era correcta por separado; el ancla original era la equivocada.
 *
 * Efecto real hoy: un anaquelista de ruta puede gestionar credenciales del SAT,
 * timbrar facturas, mover la conciliación bancaria y preguntarle a Maat por las
 * finanzas de la empresa.
 *
 * SE PONEN EN `false`, NO SE BORRA LA KEY. A propósito: los backfills de permisos
 * de este repo son idempotentes vía `permissions -> 'KEY' IS NULL`, así que si
 * borráramos la key, el próximo backfill anclado la volvería a otorgar. Dejarla
 * en `false` explícito corta la cadena de anclas de forma permanente.
 *
 * Requiere RE-LOGIN: los permisos viajan en el JWT.
 *
 * Autorizado por Edgar 2026-08-20 ("hay que eliminar esos 25 permisos fiscales").
 *
 * @param { import("knex").Knex } knex
 */

// Los 25. FINANCE_* (10) + FISCAL_* (15).
const FINANCE_FISCAL = [
  'FINANCE_AI_CHAT',
  'FINANCE_BANK_GESTIONAR',
  'FINANCE_BANK_VER',
  'FINANCE_COLLECTIONS_GESTIONAR',
  'FINANCE_COLLECTIONS_VER',
  'FINANCE_EXPENSES_VER',
  'FINANCE_FINDINGS_GESTIONAR',
  'FINANCE_PAYMENTS_GESTIONAR',
  'FINANCE_PAYMENTS_VER',
  'FINANCE_RECON_ASIGNAR',
  'FISCAL_CFDI_VER',
  'FISCAL_CONCILIACION_VER',
  'FISCAL_CONTAB_GESTIONAR',
  'FISCAL_CONTAB_VER',
  'FISCAL_CREDENCIALES_GESTIONAR',
  'FISCAL_DESCARGA_GESTIONAR',
  'FISCAL_DESCARGA_VER',
  'FISCAL_DIOT_VER',
  'FISCAL_FACTURAR_GESTIONAR',
  'FISCAL_FACTURAR_VER',
  'FISCAL_IMPUESTOS_VER',
  'FISCAL_LISTAS_GESTIONAR',
  'FISCAL_LISTAS_VER',
  'FISCAL_MATERIALIDAD_GESTIONAR',
  'FISCAL_MATERIALIDAD_VER',
];

// Roles operativos/de campo/tienda: pierden los 25 completos.
const REVOKE_ALL = [
  'colaborador',
  'vendedor',
  'repartidor',
  'supervisor_ventas',
  'jefe_marketing',
  'encargado_sucursal',
  'supervisor',
  'tele_operator',
];

// `prevencion_auditoria` conserva sus 13 permisos de LECTURA (un auditor tiene
// que poder ver lo que audita) y pierde solo los 2 de escritura, que además
// contradicen el diseño de su propio preset: "prevencion_auditoria recibe el
// secundario en SOLO-VER (un auditor no opera lo que audita)".
const REVOKE_WRITE_ONLY = ['prevencion_auditoria'];
const WRITE_ONLY = ['FISCAL_CONTAB_GESTIONAR', 'FISCAL_MATERIALIDAD_GESTIONAR'];

// Conservan los 25: dominio de Finanzas + roles de administración total.
// (finanzas, contabilidad, tesoreria, credito_cobranza, admin, superadmin, sistemas)

async function revoke(knex, roles, perms, label) {
  const patch = {};
  for (const p of perms) patch[p] = false;

  const affected = await knex.raw(
    `SELECT rp.role_name, t.slug,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
       JOIN identity.tenants t ON t.id = rp.tenant_id
      WHERE lower(rp.role_name) = ANY(?) AND rp.deleted_at IS NULL`,
    [roles],
  );

  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE lower(role_name) = ANY(?) AND deleted_at IS NULL`,
    [JSON.stringify(patch), roles],
  );

  console.log(`[revoke_finance_fiscal] ${label}: ${perms.length} permisos en ${res.rowCount ?? 0} filas de rol`);
  for (const a of affected.rows) {
    if (Number(a.usuarios) > 0) {
      console.log(`  ${a.slug}/${a.role_name}: ${a.usuarios} usuario(s) AFECTADO(S) — deben re-loguear`);
    }
  }
}

exports.up = async function up(knex) {
  await revoke(knex, REVOKE_ALL, FINANCE_FISCAL, 'roles operativos');
  await revoke(knex, REVOKE_WRITE_ONLY, WRITE_ONLY, 'prevencion_auditoria (solo escritura)');

  // Control: que ningún rol con usuarios reales quede con permisos de escritura
  // de Finanzas/Fiscal salvo los del dominio o los de administración total.
  const leak = await knex.raw(
    `SELECT rp.role_name,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND lower(rp.role_name) NOT IN ('superadmin','admin','sistemas','finanzas','contabilidad','tesoreria','credito_cobranza')
        AND (rp.permissions->>'FISCAL_CREDENCIALES_GESTIONAR')::boolean IS TRUE`,
  );
  if (leak.rows.length) {
    console.log('[revoke_finance_fiscal] AVISO — siguen con FISCAL_CREDENCIALES_GESTIONAR:');
    for (const r of leak.rows) console.log(`  ${r.role_name} (${r.usuarios} usuarios)`);
  } else {
    console.log('[revoke_finance_fiscal] OK — ningún rol fuera del dominio conserva FISCAL_CREDENCIALES_GESTIONAR');
  }
};

/**
 * Reversible: vuelve a poner los 25 en true en los roles que los tenían.
 * Solo para rollback de emergencia — reintroduce la fuga.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  const patch = {};
  for (const p of FINANCE_FISCAL) patch[p] = true;
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions || ?::jsonb
      WHERE lower(role_name) = ANY(?)`,
    [JSON.stringify(patch), REVOKE_ALL],
  );
  const w = {};
  for (const p of WRITE_ONLY) w[p] = true;
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions || ?::jsonb
      WHERE lower(role_name) = ANY(?)`,
    [JSON.stringify(w), REVOKE_WRITE_ONLY],
  );
};
