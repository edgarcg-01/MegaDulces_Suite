/**
 * Backfill: otorga `COMMERCIAL_INVENTORY_RECIBIR` al rol `supervisor`.
 *
 * **El problema no era que a algunos roles les faltara una clave nueva: es que
 * este permiso no lo tenía NINGÚN rol operativo.** El seed
 * `02_mega_dulces_initial_roles.js` reparte inventario así —
 *
 *   supervisor          VER, CONTAR, ASIGNAR, SUPERVISAR   (+ almacenes VER)
 *   colaborador         VER, CONTAR
 *   encargado_sucursal  VER                                (+ almacenes VER)
 *   gerente_de_zona     VER                                (+ almacenes VER)
 *
 * — y `RECIBIR` no aparece en ninguno. Por eso toda la estación de recepción
 * (**Andén**, *Vales* y *Caducidad*, que comparten el permiso) sólo se veía con
 * `superadmin`/`admin`, que entran por `ALL_PERMS`. No es un bug del nav: el
 * `permissionGuard` de la ruta y los `@RequirePermissions` de los controllers
 * exigen lo mismo, así que un almacenista que copiara la URL a mano recibía 403.
 *
 * **Sólo `supervisor`** (decisión del usuario, 2026-09-02). A propósito NO se
 * aplica el preset `almacen` completo: ése incluye
 * `COMMERCIAL_INVENTORY_SUPERVISAR`, que es el permiso que **autoriza un 🔴
 * retenido**. Dárselo al personal de piso les dejaría autorizar sus propios
 * rojos y desarmaría el control para el que existe el Andén. `supervisor` ya lo
 * tenía de antes, así que acá no se amplía nada de eso.
 *
 * Alcance por tenant: se actualiza por `role_name`, sin filtrar `tenant_id`,
 * igual que los backfills previos de permisos. Es un cambio del **catálogo de
 * roles** (el seed define los mismos roles para cada tenant), no un permiso
 * puntual a un usuario.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` — **NO** usar el operador `?` de
 * JSONB, que knex no escapa correctamente. Sólo agrega donde la clave falta, así
 * que un rol al que alguien ya se lo puso en `false` a mano no se pisa.
 *
 * Después de aplicarla, los usuarios afectados tienen que **volver a entrar**:
 * los permisos viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles = ['supervisor'];
  const patch = JSON.stringify({ COMMERCIAL_INVENTORY_RECIBIR: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'COMMERCIAL_INVENTORY_RECIBIR' IS NULL`,
    { patch, roles },
  );
  console.log(
    `[grant_inventory_recibir_to_supervisor] COMMERCIAL_INVENTORY_RECIBIR otorgado a ${result.rowCount ?? 0} fila(s) de rol.`,
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo
 * dejaría al supervisor sin la estación de recepción, y un rollback de esquema
 * no debería apagarle una pantalla que ya está en uso. Para quitarlo, hacerlo
 * desde la pantalla de administración de roles.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  console.log('[grant_inventory_recibir_to_supervisor] down: no-op');
};
