/**
 * Independencia de módulos — vendor-routes (Comercial · Cartera) autosuficiente.
 * Los endpoints de "mi cartera" del vendedor dejaron de pedir COMMERCIAL_CUSTOMERS_VER
 * (lecturas), VISITAS_REGISTRAR (check-in/visita/ubicación) y COMMERCIAL_ORDERS_CREAR
 * (alta rápida de cliente): ahora TODO el flujo del vendedor pide COMMERCIAL_CARTERA_VER
 * (opera su cartera con UN permiso). La administración (asignar/desasignar) sigue en
 * COMMERCIAL_CARTERA_GESTIONAR (el vendedor NO la tiene → no reasigna carteras).
 *
 * Backfill (preservar acceso): CARTERA_VER = true para todo rol interno que tenía
 * CUSTOMERS_VER o VISITAS_REGISTRAR o ORDERS_CREAR (los tres gates viejos).
 *
 * Semántica UPGRADE (no "fill-if-null"): la migración AZ 20260702190000 —que puede
 * correr antes— siembra CARTERA_VER=false para roles sin USUARIOS_ASIGNAR_RUTA. Aquí
 * subimos ese false→true donde corresponde. COALESCE trata ausente y false por igual,
 * así funciona corra AZ antes o no. Idempotente (si ya es true, el WHERE lo excluye).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('COMMERCIAL_CARTERA_VER', true)
      WHERE role_name <> 'customer_b2b'
        AND COALESCE((permissions->>'COMMERCIAL_CARTERA_VER')::boolean, false) = false
        AND (
             COALESCE((permissions->>'COMMERCIAL_CUSTOMERS_VER')::boolean, false)
          OR COALESCE((permissions->>'VISITAS_REGISTRAR')::boolean, false)
          OR COALESCE((permissions->>'COMMERCIAL_ORDERS_CREAR')::boolean, false)
        )`,
  );
  console.log(`[vendor_routes_cartera_backfill] up: filas actualizadas = ${res.rowCount ?? 0}`);
};

/**
 * No revierte (no sabemos si CARTERA_VER venía de aquí o de AZ/asignación real).
 * Down = no-op seguro. Idempotente.
 * @param { import("knex").Knex } _knex
 */
exports.down = async function (_knex) {
  console.log('[vendor_routes_cartera_backfill] down: no-op (backfill aditivo por upgrade)');
};
