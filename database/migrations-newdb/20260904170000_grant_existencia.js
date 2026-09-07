/**
 * Reparte `EXISTENCIA_VER` / `EXISTENCIA_GESTIONAR` — la pantalla nueva de Existencia, que vive
 * en DOS proyectos (Almacén y Compras) con un solo permiso.
 *
 * POR QUÉ EXISTE ESTA MIGRACIÓN. Declarar el permiso en el enum no reparte nada. Ya pasó con
 * `FISCAL_PURCHASE_BOOK_*` (LC.6.2): nació con el módulo, nunca se repartió, y **el módulo estuvo
 * en prod sin que NADIE pudiera abrirlo** — la única fila de `role_permissions` que tenía la clave
 * era `almacenista` y estaba en `false` (residuo de guardar el mapa completo desde `/admin/roles`,
 * que aterriza las claves nuevas del enum en `false`). Un módulo nuevo no está entregado hasta que
 * su permiso está REPARTIDO.
 *
 * EL CRITERIO NO SE INVENTA, SE LEE DE PROD: quien hoy ve la existencia en Almacén
 * (`COMMERCIAL_INVENTORY_VER`) o el pedido en Compras (`COMPRAS_PEDIDO_VER`) es exactamente quien
 * necesita el censo. Los dos anclas son de los dos proyectos donde la pantalla vive.
 *
 * ⛔ `customer_b2b` EXCLUIDO EXPLÍCITAMENTE. Verificado en prod: **tiene
 * `COMMERCIAL_INVENTORY_VER = true`** (el backend lo declara a propósito en
 * `commercial-inventory.controller.ts:117-120` — "customer_b2b con INVENTORY_VER ve saldos
 * disponibles"). Sin esta línea, un cliente del portal recibiría la matriz de existencia de TODA
 * la red **valuada a costo**. Es la misma clase de IDOR que cerró AUTHZ-HARD.
 *
 * ⚠️ Y por eso el ancla es específica y no benigna: anclar en un permiso que todos tienen ya
 * filtró **25 permisos** una vez (`20260820203000_revoke_finance_fiscal_from_operational_roles.js`
 * lo traza: `FINANCE_EXPENSES_VER ← COMMERCIAL_ANALYTICS_VER`, que todo rol operativo tenía).
 *
 * Medido en prod al escribir esto: 14 roles tienen alguno de los dos anclas → **13 reciben
 * EXISTENCIA_VER** (auxiliar_compras, compras, compras_operaciones, direccion, encargado_tienda,
 * finanzas, gerente_compras, marketing, prevencion, prevencion_auxiliar, superadmin, supervisor,
 * tesoreria). `almacenista` NO lo recibe: tiene el ancla en `false` explícito y el patrón respeta
 * los `false` a propósito — si el bodeguero debe verlo, se agrega desde `/admin/roles`.
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` — **NO** el operador `?` de JSONB,
 * que knex no escapa bien. Sin filtro de `tenant_id`: es un cambio del catálogo de roles.
 *
 * Después de aplicarla, los usuarios afectados tienen que **volver a entrar**: los permisos viajan
 * dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"EXISTENCIA_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> 'customer_b2b'
        AND permissions -> 'EXISTENCIA_VER' IS NULL
        AND (permissions -> 'COMMERCIAL_INVENTORY_VER' = 'true'::jsonb
          OR permissions -> 'COMPRAS_PEDIDO_VER' = 'true'::jsonb)`,
  );

  // GESTIONAR = exportar el dataset valuado de toda la red. Ancla en quien ya puede ajustar stock
  // o gestionar el pedido — no en quien sólo mira.
  const gestionar = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"EXISTENCIA_GESTIONAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> 'customer_b2b'
        AND permissions -> 'EXISTENCIA_GESTIONAR' IS NULL
        AND (permissions -> 'COMMERCIAL_INVENTORY_AJUSTAR' = 'true'::jsonb
          OR permissions -> 'COMPRAS_PEDIDO_GESTIONAR' = 'true'::jsonb)`,
  );

  console.log(
    `[grant_existencia] VER → ${ver.rowCount ?? 0} fila(s) de rol · `
    + `GESTIONAR → ${gestionar.rowCount ?? 0}. `
    + 'Los usuarios afectados deben volver a entrar (el JWT trae los permisos).',
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo apagaría la pantalla
 * para todos, y un rollback de esquema no debería hacer eso. Para quitarlo, desde `/admin/roles`.
 */
exports.down = async function () {
  // intencionalmente vacío
};
