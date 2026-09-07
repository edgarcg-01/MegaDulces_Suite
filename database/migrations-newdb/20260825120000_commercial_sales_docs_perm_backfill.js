'use strict';
/**
 * Permiso propio para `/comercial/documentos` (facturas de venta del ERP +
 * anexo imprimible con pagaré, Fase AX.2):
 *
 *   COMMERCIAL_SALES_DOCS_VER
 *
 * La página nació reusando `COMMERCIAL_ORDERS_VER`, el permiso de **Pedidos**.
 * Consecuencia: no aparecía como casilla en `/admin/roles`, así que no se podía
 * dar Documentos sin dar Pedidos, ni quitarlo sin quitar Pedidos. Mismo criterio
 * que el split de reportes de Fase AZ (`20260710130000` / `20260710140000`):
 * cada superficie con su clave, para poder acotar un rol a un solo reporte.
 *
 * Backfill no-regresión: la clave nueva hereda el valor de `ORDERS_VER`, así que
 * nadie pierde acceso. Los 4 endpoints de `commercial/sales-documents` no los
 * comparte ninguna otra página, así que el corte es limpio (cero riesgo de 403
 * cruzado).
 *
 * EXCEPCIÓN — roles del Portal B2B: NO heredan la clave. `customer_b2b` tiene
 * `ORDERS_VER` porque lo necesita para `GET /commercial/orders/my`, y ahí el
 * servicio le fuerza `customer_id` al del JWT. `sales-documents` NO hace ese
 * scoping (filtra sólo por `tenant_id`), así que copiarle la clave le abriría
 * las facturas de TODOS los clientes de la tenant: nombre, RFC y monto. El
 * split es justo el momento de no arrastrar eso.
 *
 * ORDEN DE DESPLIEGUE: esta migración PRIMERO, después el redeploy. Al revés,
 * quien tenga Pedidos se queda sin la página hasta que corra el backfill.
 * Requiere RE-LOGIN: el frontend gatea con el snapshot de permisos del JWT.
 *
 * Idempotente: sólo escribe si la clave no existe (`-> 'KEY' IS NULL`).
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'COMMERCIAL_SALES_DOCS_VER';

exports.up = async function up(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text,
              COALESCE((permissions->>'COMMERCIAL_ORDERS_VER')::boolean, false)
              AND NOT COALESCE((permissions->>'PORTAL_B2B_ACCESS')::boolean, false)),
            updated_at = now()
      WHERE permissions -> ?::text IS NULL`,
    [KEY, KEY],
  );
  console.log(`[sales_docs_perm] ${KEY} (<- COMMERCIAL_ORDERS_VER): filas = ${res.rowCount ?? 0}`);

  const det = await knex.raw(
    `SELECT rp.role_name,
            (SELECT count(*) FROM identity.users u
              WHERE u.tenant_id = rp.tenant_id
                AND lower(u.role_name) = lower(rp.role_name)
                AND u.deleted_at IS NULL) AS usuarios
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND (rp.permissions->>?::text)::boolean IS TRUE
      ORDER BY 2 DESC, 1`,
    [KEY],
  );
  let total = 0;
  for (const r of det.rows) {
    total += Number(r.usuarios);
    if (Number(r.usuarios) > 0) console.log(`  ${r.role_name}: ${r.usuarios} usuario(s)`);
  }
  console.log(`[sales_docs_perm] usuarios con /comercial/documentos: ${total} — deben RE-LOGUEAR`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text
      WHERE permissions -> ?::text IS NOT NULL`,
    [KEY, KEY],
  );
  console.log(`[sales_docs_perm] down: clave removida en ${res.rowCount ?? 0} filas`);
};
