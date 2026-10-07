'use strict';
/**
 * `[CE.4]` — Reparte `COMPRAS_COSTO_ESTANDAR_VER`.
 *
 * ⭐ **La lección de `[LC.6.2]`: un módulo nuevo no está entregado hasta que su permiso está
 * REPARTIDO en prod, no sólo declarado en el enum.** Ahí un par de claves nació con su fase,
 * nunca lo repartió ni el seed ni una migración, y el módulo estuvo en producción con **cero
 * roles** capaces de abrirlo — la única fila que tenía la clave la tenía en `false`, residuo de
 * guardar el mapa completo desde `/admin/roles`.
 *
 * ── El reparto se DERIVA del estado vivo, no de una lista escrita a mano ────────────────
 *
 * Se calca al hermano de la misma familia y el mismo proyecto, `COMPRAS_COSTO_NETO_VER`
 * (*Costo por proveedor*), que publica información del mismo grado de sensibilidad: costos de
 * compra por producto. Medido en prod el 2026-09-29, lo tienen en `true` **10 roles**:
 * `auxiliar_compras`, `compras`, `compras_operaciones`, `direccion`, `encargado_tienda`,
 * `finanzas`, `gerente_compras`, `marketing`, `superadmin`, `tesoreria`.
 *
 * Derivarlo en vez de listarlo es lo que hace que la migración siga siendo correcta si alguien
 * movió un rol entre que esto se escribió y se aplicó.
 *
 * ── Tres cuidados ──────────────────────────────────────────────────────────────────────
 *
 *  · ⚠️ **`permissions -> 'KEY' IS NULL`, nunca el operador `?` de JSONB**: knex no lo escapa
 *    bien y termina tomándolo como binding (regla dura del proyecto).
 *  · Los roles `retirado_*` quedan fuera: no se le reparte nada a un rol dado de baja.
 *  · Un `false` existente **no se pisa**. Si alguien ya decidió negarlo explícitamente, esta
 *    migración no revierte esa decisión — sólo llena la ausencia.
 *
 * No hay clave `GESTIONAR`: la pantalla es de sólo lectura. El costo estándar se corrige **en
 * Kepler**, que es el sistema de registro del catálogo (ADR-040).
 */

const CLAVE = 'COMPRAS_COSTO_ESTANDAR_VER';
const HERMANO = 'COMPRAS_COSTO_NETO_VER';

exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('public.role_permissions') IS NOT NULL AS hay`)).rows;
  if (!hay) {
    // eslint-disable-next-line no-console
    console.log('  no existe public.role_permissions — reparto omitido');
    return;
  }

  const { rows: destino } = await knex.raw(
    `SELECT role_name
       FROM public.role_permissions
      WHERE (permissions -> ?) = 'true'::jsonb
        AND (permissions -> ?) IS NULL
        AND role_name NOT LIKE 'retirado\\_%'`,
    [HERMANO, CLAVE],
  );

  if (!destino.length) {
    // eslint-disable-next-line no-console
    console.log(`  ${CLAVE}: nada que repartir (ya estaba, o nadie tiene ${HERMANO})`);
    return;
  }

  await knex.raw(
    `UPDATE public.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true),
            updated_at  = NOW()
      WHERE (permissions -> ?) = 'true'::jsonb
        AND (permissions -> ?) IS NULL
        AND role_name NOT LIKE 'retirado\\_%'`,
    [CLAVE, HERMANO, CLAVE],
  );

  // Prueba de que hizo lo que dice: se vuelve a contar DESPUÉS de escribir.
  const [{ n }] = (await knex.raw(
    `SELECT count(*)::int AS n FROM public.role_permissions WHERE (permissions -> ?) = 'true'::jsonb`,
    [CLAVE],
  )).rows;
  // eslint-disable-next-line no-console
  console.log(`  ${CLAVE}: repartido a ${destino.length} rol(es) — ahora en ${n} en total`);
  if (n < destino.length) throw new Error(`[CE.4] el reparto de ${CLAVE} no cuadra`);
};

exports.down = async function down(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('public.role_permissions') IS NOT NULL AS hay`)).rows;
  if (!hay) return;
  await knex.raw(
    `UPDATE public.role_permissions
        SET permissions = permissions - ?::text, updated_at = NOW()
      WHERE (permissions -> ?) IS NOT NULL`,
    [CLAVE, CLAVE],
  );
};
