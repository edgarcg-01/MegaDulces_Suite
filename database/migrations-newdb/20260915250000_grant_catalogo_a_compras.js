'use strict';
/**
 * `[CAT.5]` — El catálogo se mudó a Compras y el equipo de Compras no lo veía.
 *
 * ── Cómo apareció ─────────────────────────────────────────────────────────────────────────────
 * `mario_ventura` (rol `auxiliar_compras`) reportó que en **Compras → Catálogo** sólo le salían
 * Proveedores y Categorías. Medido en prod, el grupo entero estaba al revés:
 *
 *   gerente_compras      ve catálogo ✅   pedido ✅   proveedores ✅    1 usuario
 *   auxiliar_compras     ve catálogo ❌   pedido ✅   proveedores ✅    4 usuarios
 *   compras              ve catálogo ❌   pedido ✅   proveedores ✅    2 usuarios
 *   compras_operaciones  ve catálogo ❌   pedido ✅   proveedores ✅    1 usuario
 *
 * Siete personas que levantan pedidos y editan proveedores en ese mismo proyecto, sin ver el
 * catálogo de productos. Y de los seis roles que SÍ lo ven, cuatro son de Ventas, Marketing y
 * Cobranza. El catálogo se mudó a Compras porque **el comprador es quien lo mantiene** (da de
 * alta el producto, negocia el costo y captura el precio en Kepler); que justo él no lo viera
 * dejaba la mudanza a medias.
 *
 * ⚠️ **No es una regresión de la mudanza.** Antes de `[CAT.1]` estas tres filas tenían las DOS
 * llaves en false —la vieja del menú (`CATALOGO_GESTIONAR`) y la de la ruta
 * (`COMMERCIAL_PRODUCTS_VER`)—, así que tampoco veían el catálogo cuando vivía en Ventas. Lo que
 * hizo la mudanza fue volver absurda una configuración que ya estaba mal.
 *
 * ── ⭐ POR QUÉ ESTA PISA UN `false` Y LAS OTRAS NO ────────────────────────────────────────────
 * El patrón canónico del repo (`20260914150000_grant_presupuestos_to_roles`) es idempotente por
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó", y **no pisa un `false` explícito** porque
 * puede ser una decisión manual tomada desde `/admin/roles`. Acá el `false` NO es una decisión, y
 * está medido:
 *
 *   auxiliar_compras       171 claves, 143 en false
 *   compras_operaciones    170 claves, 142 en false
 *   compras                163 claves, 117 en false
 *   direccion (curado)      93 claves,   3 en false
 *
 * Nadie deniega 143 permisos uno por uno. Ésa es la firma de haber guardado el mapa completo
 * desde `/admin/roles`, que deja en `false` toda clave del enum que el rol no tenía — el mismo
 * residuo que documentó `[LC.6.2]`. Con la guarda de `IS NULL` esta migración sería un no-op y el
 * problema seguiría ahí, así que se pisa **a propósito**, acotado a UNA clave y TRES roles, y
 * dejando constancia de lo que cambió.
 *
 * Alcance decidido con el dueño del área: **sólo lectura**. `COMMERCIAL_PRODUCTS_GESTIONAR` NO se
 * reparte — editar la ficha puede esperar a que alguien lo pida.
 *
 * Se apunta por `id` de fila, no por `role_name`: la tabla es por tenant y un mismo rol puede
 * tener varias filas; filtrar por nombre tocaría también la de otro tenant.
 *
 * Los permisos viajan en el JWT → **los 7 usuarios afectados deben volver a entrar**.
 *
 * @param { import("knex").Knex } knex
 */

const PERM = 'COMMERCIAL_PRODUCTS_VER';
const ROLES = ['auxiliar_compras', 'compras', 'compras_operaciones'];

exports.up = async function up(knex) {
  const { rows: destino } = await knex.raw(
    `SELECT id, role_name, permissions -> ?::text AS ya
       FROM identity.role_permissions
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL`,
    [PERM, ROLES],
  );

  if (!destino.length) {
    console.log(`[grant_catalogo_compras] ningún rol destino encontrado: ${ROLES.join(', ')}`);
    return;
  }

  const yaEstaban = destino.filter((r) => r.ya === true).map((r) => r.role_name);
  const porTocar = destino.filter((r) => r.ya !== true);

  if (porTocar.length) {
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE id = ANY(?) AND deleted_at IS NULL`,
      [JSON.stringify({ [PERM]: true }), porTocar.map((r) => r.id)],
    );
    const detalle = porTocar
      .map((r) => `${r.role_name}(${r.ya === null ? 'sin la clave' : 'estaba en false'})`)
      .join(', ');
    console.log(`[grant_catalogo_compras] ${PERM} otorgado en ${res.rowCount ?? 0} fila(s): ${detalle}`);
  }
  if (yaEstaban.length) {
    console.log(`[grant_catalogo_compras] ya lo tenían, sin tocar: ${yaEstaban.join(', ')}`);
  }
  console.log('[grant_catalogo_compras] los usuarios de esos roles deben RE-LOGUEAR (el permiso va en el JWT).');
};

/**
 * Vuelve a `false`, no a ausente: la clave existía (en false) antes de esta migración en los tres
 * roles, así que borrarla dejaría la fila distinta de como estaba.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL`,
    [JSON.stringify({ [PERM]: false }), ROLES],
  );
  console.log(`[grant_catalogo_compras] revertido a false en ${res.rowCount ?? 0} fila(s).`);
};
