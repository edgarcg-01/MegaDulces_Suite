/**
 * LC.6.2 — Reparte `FISCAL_PURCHASE_BOOK_VER` / `_GESTIONAR`.
 *
 * **El módulo estaba en prod y no se podía abrir.** El par de permisos nació con el módulo
 * (LC.6) pero nunca lo repartió nadie: sólo existe en el enum de `permissions.ts`, sin seed
 * ni migración. Medido en prod el 2026-09-02, la única fila de `role_permissions` que tenía
 * las claves era `almacenista`… **en `false`** — residuo de guardar el mapa completo desde
 * `/admin/roles` (la pantalla escribe todo el JSONB, así que una clave nueva del enum
 * aterriza en `false`). O sea: cero roles con acceso, y sólo `superadmin`/`admin` entrando
 * por `ALL_PERMS`. El `permissionGuard` de la ruta y los `@RequirePermissions` del
 * controller exigen lo mismo, así que quien copiara la URL a mano recibía 403.
 *
 * **A quién:** se calca el hermano del mismo proyecto Contabilidad — `FISCAL_CONTAB_*`, que
 * gatea Pólizas y Contabilidad electrónica. El criterio no se inventa, se lee del estado
 * vivo de prod: quien ya puede **ver** pólizas puede ver el libro; quien ya puede
 * **gestionarlas** puede generar el TXT. Medido: `FISCAL_CONTAB_VER = true` en 12 roles,
 * `_GESTIONAR = true` en 9 (contabilidad, finanzas, credito_cobranza, gerente_compras,
 * direccion, auditor_externo, marketing…).
 *
 * **Excepción a propósito: los `retirado_*` NO.** Son roles dados de baja; darles un
 * permiso nuevo es ruido que después hay que limpiar. El nombre hace la intención
 * inequívoca, así que se filtran.
 *
 * `GESTIONAR` implica `VER` (la ruta se gatea con VER), así que el grant de VER cubre
 * también a quien tenga sólo el gestionar del hermano — de ahí el `OR`.
 *
 * Alcance por tenant: se actualiza por `role_name` sin filtrar `tenant_id`, igual que los
 * demás backfills de permisos: es un cambio del **catálogo de roles** (el seed define los
 * mismos roles para cada tenant), no un permiso puntual a un usuario.
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` — **NO** el operador `?` de
 * JSONB, que knex no escapa bien. Sólo agrega donde la clave falta, así que a quien alguien
 * ya se lo puso en `false` a mano (el caso `almacenista`) **no se le pisa**.
 *
 * Después de aplicarla los usuarios afectados tienen que **volver a entrar**: los permisos
 * viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"FISCAL_PURCHASE_BOOK_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'FISCAL_PURCHASE_BOOK_VER' IS NULL
        AND (permissions -> 'FISCAL_CONTAB_VER' = 'true'::jsonb
          OR permissions -> 'FISCAL_CONTAB_GESTIONAR' = 'true'::jsonb)`,
  );

  const gestionar = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"FISCAL_PURCHASE_BOOK_GESTIONAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'FISCAL_PURCHASE_BOOK_GESTIONAR' IS NULL
        AND permissions -> 'FISCAL_CONTAB_GESTIONAR' = 'true'::jsonb`,
  );

  console.log(
    `[grant_purchase_book_to_contabilidad] VER → ${ver.rowCount ?? 0} fila(s) de rol · `
    + `GESTIONAR → ${gestionar.rowCount ?? 0}. Los usuarios afectados deben volver a entrar (el JWT trae los permisos).`,
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo dejaría a
 * contabilidad sin el libro de compras, y un rollback de esquema no debería apagar una
 * pantalla en uso. Para quitarlo, hacerlo desde `/admin/roles`.
 */
exports.down = async function () {
  console.log('[grant_purchase_book_to_contabilidad] down: no-op');
};
