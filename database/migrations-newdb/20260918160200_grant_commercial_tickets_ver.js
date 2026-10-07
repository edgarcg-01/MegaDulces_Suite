/**
 * Fase TK.0c — Reparte `COMMERCIAL_TICKETS_VER`.
 *
 * **Un módulo nuevo no está entregado hasta que su permiso está REPARTIDO, no sólo declarado
 * en el enum.** Es la lección que costó LC.6.2: el par `FISCAL_PURCHASE_BOOK_*` nació con su
 * módulo, vivió en prod y **nadie podía abrirlo** porque ninguna migración lo repartió — la
 * única fila de `role_permissions` que tenía la clave la tenía en `false` (residuo de guardar
 * el mapa completo desde `/admin/roles`, que aterriza en `false` toda clave nueva del enum).
 *
 * **A quién:** se calca el hermano de superficie, `COMMERCIAL_SALES_DOCS_VER`, que gatea
 * Facturación de Telemarketing. El criterio no se inventa, se lee del estado vivo: quien ya
 * puede abrir un documento de venta del ERP y reimprimir su anexo, puede buscar un folio y
 * reimprimir su ticket. Medido en `platform_test` el 2026-09-18, esa clave está en `true` en
 * **12 roles**: credito_cobranza, direccion, encargado_tienda, gerente_compras, jefe_marketing,
 * marketing, repartidor, superadmin, supervisor_ventas, telemarketing, tm_una_suc,
 * vendedor_ruta.
 *
 * Que `encargado_tienda` ya esté en esa lista es lo que hace que el mostrador quede cubierto
 * sin ampliar el alcance a mano: es justo quien va a atender al cliente que pide su ticket.
 *
 * **Excepción a propósito: los `retirado_*` NO.** Son roles dados de baja; darles un permiso
 * nuevo es ruido que después hay que limpiar.
 *
 * Alcance por tenant: se actualiza por `role_name` sin filtrar `tenant_id`, igual que los demás
 * backfills de permisos — es un cambio del CATÁLOGO de roles (el seed define los mismos roles
 * para cada tenant), no un permiso puntual a un usuario.
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` — **NO** el operador `?` de
 * JSONB, que knex no escapa bien. Sólo agrega donde la clave falta, así que a quien alguien ya
 * se lo haya puesto en `false` a mano NO se le pisa.
 *
 * Después de aplicarla los usuarios afectados tienen que **volver a entrar**: los permisos
 * viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const r = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_TICKETS_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'COMMERCIAL_TICKETS_VER' IS NULL
        AND permissions -> 'COMMERCIAL_SALES_DOCS_VER' = 'true'::jsonb`,
  );
  console.log(
    `[grant_commercial_tickets_ver] COMMERCIAL_TICKETS_VER → ${r.rowCount ?? 0} fila(s) de rol. `
    + 'Los usuarios afectados deben volver a entrar (el JWT trae los permisos).',
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo apagaría una
 * pantalla en uso, y un rollback de esquema no debería hacer eso. Para quitarlo, desde
 * `/admin/roles`.
 */
exports.down = async function down() {
  console.log('[grant_commercial_tickets_ver] down: no-op');
};
