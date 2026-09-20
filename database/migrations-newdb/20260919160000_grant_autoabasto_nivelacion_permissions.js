/**
 * AB.2 — Reparte las 7 llaves de **Autoabasto** y **Nivelación** (Fase AB).
 *
 * **La lección LC.6.2, otra vez aplicada antes de que muerda:** un módulo no está entregado
 * hasta que su permiso está REPARTIDO, no sólo declarado en el enum. `FISCAL_PURCHASE_BOOK_*`
 * nació con su módulo, nadie lo repartió, y el módulo vivió en producción sin que NADIE pudiera
 * abrirlo salvo por `ALL_PERMS`. Misma forma que CG.14 (`20260918170000`).
 *
 * ── A quién: derivado del estado vivo, medido el 2026-09-19 sobre los 38 roles no retirados ──
 *
 *   COMMERCIAL_INVENTORY_VER      true en 11  (almacenista, compras, customer_b2b, direccion,
 *                                              encargado_tienda, gerente_compras, marketing,
 *                                              prevencion, prevencion_auxiliar, superadmin,
 *                                              supervisor)
 *   COMMERCIAL_INVENTORY_AJUSTAR  true en  7  (almacenista, compras, encargado_tienda,
 *                                              gerente_compras, marketing, superadmin,
 *                                              supervisor)
 *   COMPRAS_PEDIDO_VER            true en 10  (auxiliar_compras, compras, compras_operaciones,
 *                                              direccion, encargado_tienda, finanzas,
 *                                              gerente_compras, marketing, superadmin,
 *                                              tesoreria)
 *   COMPRAS_PEDIDO_GESTIONAR      true en  9  (los mismos sin direccion, que está en NULL)
 *   FINANCE_PAYMENT_CALENDAR_AUTORIZAR true en 2 (direccion, superadmin)
 *
 * · VER          → quien ya ve la existencia (`COMMERCIAL_INVENTORY_VER`) **o** quien ya ve
 *                  Existencia Crítica (`COMPRAS_PEDIDO_VER`). La mesa sirve los MISMOS números
 *                  que `/compras/existencia` —mismo `CommercialReplenishmentService`—, así que
 *                  este reparto **no expone un dato nuevo a nadie**: cambia la superficie, no
 *                  el alcance.
 *
 * · SOLICITAR    → quien ya puede MOVER inventario (`COMMERCIAL_INVENTORY_AJUSTAR`). Preparar
 *                  una solicitud de abasto pesa lo mismo que ajustar una existencia. Este
 *                  anclaje es el que le abre la puerta al **almacenista**, que es el punto de
 *                  la fase: hoy tiene `COMPRAS_PEDIDO_VER` en `false` explícito y por eso NO
 *                  alcanza Existencia Crítica — la persona que hace el trabajo es justo la que
 *                  no ve los números. Ese `false` es una decisión manual guardada desde
 *                  `/admin/roles` y **no se pisa**: se abre con llave propia.
 *
 * · AUTORIZAR    → quien ya GESTIONA el pedido de compra (`COMPRAS_PEDIDO_GESTIONAR`), más
 *                  dirección. **SOLICITAR ≠ AUTORIZAR** (§2 del pedido) y este anclaje lo
 *                  sostiene solo: `almacenista` tiene `COMPRAS_PEDIDO_GESTIONAR` en `false`
 *                  explícito, así que queda fuera por su propio estado — quien prepara no firma.
 *                  El OR con `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` existe porque `direccion`
 *                  tiene esa clave en NULL y sin el OR la dirección quedaría sin firmar.
 *
 * · EXCEDER_TOPE → se calca `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (direccion, superadmin), el
 *                  precedente vivo de permiso restringido (TP.6). Es una TERCERA llave, no un
 *                  AUTORIZAR más grande: el tope de inventario sólo lo pasa dirección comercial
 *                  o general (§2 del pedido).
 * · POLITICA     → igual que EXCEDER_TOPE: mover el umbral de temporalidad decide dirección.
 *
 * · NIVELACION_VER       → `COMMERCIAL_INVENTORY_VER`, sin el OR de Compras: el traspaso lo mira
 *                  el almacén de ORIGEN y el de destino, no el comprador.
 * · NIVELACION_GESTIONAR → `COMMERCIAL_INVENTORY_AJUSTAR`, el mismo set que SOLICITAR: confirmar
 *                  o rechazar un traspaso es mover existencia.
 *
 * ── ⚠️ `customer_b2b` se excluye a mano, y es lo único que no sale de una derivación ─────────
 * `customer_b2b` tiene `COMMERCIAL_INVENTORY_VER = true` **y es el portal EXTERNO**: su perfil
 * son 9 claves y una de ellas es `PORTAL_B2B_ACCESS`; ve existencia para poder pedir, no para
 * operar el almacén. Tiene **3 usuarios vivos** (`cliente_v-7a228b58c2`, `cliente_demo`,
 * `edgar_cortes`). Sin este `NOT IN`, derivar de `COMMERCIAL_INVENTORY_VER` le entregaría la
 * mesa interna de reabasto a tres cuentas de cliente. Medido, no supuesto.
 *
 * Los `retirado_*` NO, a propósito: son roles dados de baja y darles una clave nueva es ruido
 * que después hay que limpiar.
 *
 * Idempotente y NO destructiva: `permissions -> 'KEY' IS NULL` — **NO** el operador `?` de
 * JSONB, que knex no escapa bien (GOTCHAS). Sólo agrega donde la clave falta, así que a quien
 * alguien ya se lo haya puesto en `false` a mano desde `/admin/roles` NO se le pisa.
 *
 * Alcance por `role_name` sin filtrar `tenant_id`: es un cambio del CATÁLOGO de roles (el seed
 * define los mismos roles para cada tenant), igual que los demás backfills de permisos.
 *
 * ⚠️ Después de aplicarla los usuarios afectados tienen que **volver a entrar**: los permisos
 * viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */

// Roles EXTERNOS que nunca deben recibir una llave de operación interna, por más que la
// derivación los alcance. Hoy sólo el portal B2B; si nace otro, se suma acá.
const EXTERNOS = ['customer_b2b'];

exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"AUTOABASTO_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> ALL(?)
        AND permissions -> 'AUTOABASTO_VER' IS NULL
        AND ( (permissions ->> 'COMMERCIAL_INVENTORY_VER')::boolean IS TRUE
           OR (permissions ->> 'COMPRAS_PEDIDO_VER')::boolean IS TRUE )`, [EXTERNOS]);

  const sol = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"AUTOABASTO_SOLICITAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> ALL(?)
        AND permissions -> 'AUTOABASTO_SOLICITAR' IS NULL
        AND (permissions ->> 'COMMERCIAL_INVENTORY_AJUSTAR')::boolean IS TRUE`, [EXTERNOS]);

  const aut = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"AUTOABASTO_AUTORIZAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> ALL(?)
        AND permissions -> 'AUTOABASTO_AUTORIZAR' IS NULL
        AND ( (permissions ->> 'COMPRAS_PEDIDO_GESTIONAR')::boolean IS TRUE
           OR (permissions ->> 'FINANCE_PAYMENT_CALENDAR_AUTORIZAR')::boolean IS TRUE )`, [EXTERNOS]);

  const tope = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"AUTOABASTO_EXCEDER_TOPE": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'AUTOABASTO_EXCEDER_TOPE' IS NULL
        AND (permissions ->> 'FINANCE_PAYMENT_CALENDAR_AUTORIZAR')::boolean IS TRUE`);

  const pol = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"AUTOABASTO_POLITICA": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'AUTOABASTO_POLITICA' IS NULL
        AND (permissions ->> 'FINANCE_PAYMENT_CALENDAR_AUTORIZAR')::boolean IS TRUE`);

  const nver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"NIVELACION_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> ALL(?)
        AND permissions -> 'NIVELACION_VER' IS NULL
        AND (permissions ->> 'COMMERCIAL_INVENTORY_VER')::boolean IS TRUE`, [EXTERNOS]);

  const nges = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"NIVELACION_GESTIONAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> ALL(?)
        AND permissions -> 'NIVELACION_GESTIONAR' IS NULL
        AND (permissions ->> 'COMMERCIAL_INVENTORY_AJUSTAR')::boolean IS TRUE`, [EXTERNOS]);

  // eslint-disable-next-line no-console
  console.log(
    `[AB.2] permisos repartidos — AUTOABASTO_VER: ${ver.rowCount} · SOLICITAR: ${sol.rowCount} · ` +
    `AUTORIZAR: ${aut.rowCount} · EXCEDER_TOPE: ${tope.rowCount} · POLITICA: ${pol.rowCount} · ` +
    `NIVELACION_VER: ${nver.rowCount} · NIVELACION_GESTIONAR: ${nges.rowCount} filas de role_permissions`);
};

exports.down = async function (knex) {
  for (const k of [
    'AUTOABASTO_VER', 'AUTOABASTO_SOLICITAR', 'AUTOABASTO_AUTORIZAR',
    'AUTOABASTO_EXCEDER_TOPE', 'AUTOABASTO_POLITICA',
    'NIVELACION_VER', 'NIVELACION_GESTIONAR',
  ]) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${k}'`);
  }
};
