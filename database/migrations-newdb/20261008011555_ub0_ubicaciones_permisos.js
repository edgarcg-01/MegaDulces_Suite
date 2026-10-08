'use strict';
/**
 * `[UB.0]` — Reparto de los permisos del módulo Ubicaciones (Fase UB, ADR-090).
 *
 * Autorizado por Francisco López (2026-10-08): reparto de FASE_UB §4.2.
 *
 * ── Lo medido en prod antes de escribir esto (solo lectura, 2026-10-08) ─────────────────────────
 *  · Los 14 roles destino existen con esos nombres; ninguno tenía todavía ALMACEN_UBICACIONES_*.
 *  · Hoy las ubicaciones cuelgan de COMMERCIAL_INVENTORY_VER/RECIBIR: auxiliar_tienda y
 *    piso_tienda las tienen en `false` explícito, o sea que hoy NO pueden acomodar aunque su
 *    trabajo sea ése. Esta migración no toca esas claves: les da las propias del módulo.
 *  · `superadmin` no se reparte: entra por nombre de rol (ADR-054, isPlatformAdminRole).
 *  · `marketing` y `jefe_marketing` tienen permisos amplios de almacén y NO reciben Ubicaciones,
 *    a propósito (FASE_UB §4.2).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────────
 *   Pone en `true` cada clave en su rol SÓLO si la clave no existe en su mapa
 *   (`permissions -> 'X' IS NULL`, no el operador `?`). Un `false` explícito —puesto por un humano
 *   desde /admin/roles— se respeta y se reporta en voz alta (lección [LC.6.2] / [IC.23]).
 *
 *   El ALCANCE no se toca: cada rol ya trae el suyo (encargado_tienda y auxiliar_tienda =
 *   warehouse:own; encargado_bodega = sólo 00; almacenista = all). El servicio de ubicaciones lo
 *   aplica con ScopeService (`[UB.1]`).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VER = 'ALMACEN_UBICACIONES_VER';
const ACOMODAR = 'ALMACEN_UBICACIONES_ACOMODAR';
const GESTIONAR = 'ALMACEN_UBICACIONES_GESTIONAR';
const CLAVES = [VER, ACOMODAR, GESTIONAR];

/** Rol → claves que recibe (FASE_UB §4.2). */
const REPARTO = {
  // Gestionan el catálogo de SU almacén (el alcance de cada rol lo recorta).
  encargado_tienda: [VER, ACOMODAR, GESTIONAR],
  encargado_bodega: [VER, ACOMODAR, GESTIONAR],
  supervisor: [VER, ACOMODAR, GESTIONAR],
  // Trabajo de piso.
  almacenista: [VER, ACOMODAR],
  auxiliar_tienda: [VER, ACOMODAR],
  piso_tienda: [VER, ACOMODAR],
  // Consulta.
  compras: [VER],
  gerente_compras: [VER],
  telemarketing: [VER],
  facturacion: [VER],
  coordinador_embarques: [VER],
  prevencion: [VER],
  prevencion_auxiliar: [VER],
  direccion: [VER],
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) throw new Error('No se encontró el tenant mega_dulces.');

  const existentes = new Set(
    (
      await knex('identity.role_permissions')
        .where({ tenant_id: tenant })
        .whereNull('deleted_at')
        .whereIn('role_name', Object.keys(REPARTO))
        .select('role_name')
    ).map((r) => r.role_name),
  );
  const faltan = Object.keys(REPARTO).filter((r) => !existentes.has(r));
  if (faltan.length) {
    // En una base de desarrollo pueden faltar roles; en prod se midió que existen los 14.
    console.log(`  ⚠️ [UB.0] roles que no existen en esta base (se saltan): ${faltan.join(', ')}`);
  }

  for (const [rol, claves] of Object.entries(REPARTO)) {
    if (!existentes.has(rol)) continue;
    const puestas = [];
    for (const clave of claves) {
      const r = await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions || jsonb_build_object(?::text, true), updated_at = now()
          WHERE tenant_id = ? AND role_name = ? AND deleted_at IS NULL AND permissions -> ? IS NULL
          RETURNING role_name`,
        [clave, tenant, rol, clave],
      );
      if (r.rows.length) puestas.push(clave.replace('ALMACEN_UBICACIONES_', ''));
    }
    console.log(`  [UB.0] ${rol} → ${puestas.join(', ') || '(ya las tenía)'}`);
  }

  // ── Compuerta: un false explícito se respeta, pero se dice ───────────────────────────────────
  const conFalse = await knex.raw(
    `SELECT rp.role_name, k.clave
       FROM identity.role_permissions rp
       CROSS JOIN unnest(?::text[]) AS k(clave)
      WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL AND rp.role_name = ANY(?::text[])
        AND (rp.permissions -> k.clave)::text = 'false'`,
    [CLAVES, tenant, Object.keys(REPARTO)],
  );
  const esperados = new Set(Object.entries(REPARTO).flatMap(([rol, cs]) => cs.map((c) => `${rol}:${c}`)));
  const bloqueados = conFalse.rows.filter((r) => esperados.has(`${r.role_name}:${r.clave}`));
  if (bloqueados.length) {
    console.log(`  ⚠️ [UB.0] siguen en false explícito: ${bloqueados.map((r) => `${r.role_name}.${r.clave}`).join(', ')}`);
  }
};

exports.down = async function down(knex) {
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) return;
  // Sólo donde está en `true`. Un `false` puesto a mano NO se borra: el `up` lo respetó y el
  // `down` tiene que respetarlo igual (residuo que causó [LC.6.2]).
  for (const clave of CLAVES) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now()
        WHERE tenant_id = ? AND (permissions -> ?)::text = 'true'`,
      [clave, tenant, clave],
    );
  }
};
