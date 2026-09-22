'use strict';
/**
 * `[E.12.2]` — Reparte `COMMERCIAL_QUOTES_VER` / `_GESTIONAR`.
 *
 * ── Por qué existe esta migración ───────────────────────────────────────────────────────────
 * El par nació con el submódulo (E.12.0) y quedó **sólo en el enum**: sin seed y sin migración.
 * Eso es exactamente la lección `[LC.6.2]` —un módulo que llegó a prod y **nadie podía abrir**,
 * porque el permiso estaba declarado y no repartido—. La ruta se gatea con
 * `permissionGuard(COMMERCIAL_QUOTES_VER)` y el controller con `@RequirePermissions`, así que
 * sin esto sólo entran los roles de plataforma por god-mode y cualquier otro recibe 403.
 *
 * ── A quién: se calca el hermano del MISMO módulo, y se mide antes ──────────────────────────
 * El criterio no se inventa. Cotizaciones vive **dentro** de Telemarketing, cuyo shell está
 * gateado por `televentaGuard`, y ese guard exige **`COMMERCIAL_TELEVENTA_OPERATE === true`**
 * (es exact-key: no hay herencia desde el hermano `_VER`).
 *
 * Consecuencia medida el 2026-09-21 sobre el estado vivo — y es la razón de que la lista sea
 * corta: **un permiso de cotizaciones en un rol que no puede ENTRAR al módulo es una llave que
 * no abre nada.** Quien la tenga igual choca contra el guard del shell antes de llegar a la
 * pantalla. Por eso se reparte exactamente a quien puede entrar:
 *
 *   · `COMMERCIAL_TELEVENTA_OPERATE = true` → recibe **VER y GESTIONAR**. Opera el canal:
 *     levanta pedidos, así que ofrecer precio es parte del mismo trabajo.
 *
 * ⚠️ **Lo que NO se reparte, a propósito, y queda como decisión declarada:**
 *   · `direccion` (1 usuario) tiene `COMMERCIAL_TELEVENTA_VER = true` pero **no** `OPERATE`, y
 *     el guard del shell ignora el `_VER` → hoy **no puede entrar a Telemarketing**. Su llave
 *     de lectura del módulo ya está muerta, y darle la de cotizaciones no la reviviría. Es una
 *     incoherencia PREEXISTENTE del guard, anterior a esta fase; arreglarla es abrirle el
 *     módulo entero (cola y toma de pedido incluidas), y eso es una decisión de negocio, no un
 *     retoque técnico que corresponda colar acá.
 *   · `supervisor` (1) y `supervisor_ventas` (3) tienen Telemarketing en **false** explícito.
 *     Un `false` puesto a mano no se pisa (ver la idempotencia de abajo), y darles la llave
 *     sólo agregaría 4 usuarios más con un permiso que no abre nada.
 *
 * Si el negocio quiere que Dirección o los supervisores vean cotizaciones, el cambio correcto
 * es darles acceso al módulo (o gatear el shell por `_VER` además de `_OPERATE`), no repartir
 * un permiso huérfano.
 *
 * ── Idempotente y no destructivo ────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` — **NO** el operador `?` de JSONB, que knex no escapa bien.
 * Sólo agrega donde la clave falta: a quien ya la tenga (en `true` o en `false` puesto a mano
 * desde `/admin/roles`, que escribe el JSONB entero) **no se le pisa**.
 *
 * Los `retirado_*` se excluyen: son roles dados de baja y darles un permiso nuevo es ruido que
 * después hay que limpiar.
 *
 * Alcance por `role_name` sin filtrar `tenant_id`, igual que el resto de los backfills de
 * permisos del repo: es un cambio del **catálogo de roles**, no un permiso puntual a un usuario.
 *
 * ⚠️ Después de aplicarla, los usuarios afectados tienen que **volver a entrar**: los permisos
 * viajan dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_QUOTES_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'COMMERCIAL_QUOTES_VER' IS NULL
        AND permissions -> 'COMMERCIAL_TELEVENTA_OPERATE' = 'true'::jsonb`,
  );

  const gestionar = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"COMMERCIAL_QUOTES_GESTIONAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'COMMERCIAL_QUOTES_GESTIONAR' IS NULL
        AND permissions -> 'COMMERCIAL_TELEVENTA_OPERATE' = 'true'::jsonb`,
  );

  // Se imprime el conteo REAL, no un "listo": si sale 0 en un entorno donde se esperaban filas,
  // eso es la señal de que el módulo va a quedar cerrado otra vez.
  console.log(
    `[grant_quotes_permissions] VER → ${ver.rowCount ?? 0} fila(s) de rol · ` +
      `GESTIONAR → ${gestionar.rowCount ?? 0}. ` +
      'Los usuarios afectados deben volver a entrar (el JWT trae los permisos).',
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocarlo dejaría a
 * telemarketing sin cotizaciones, y un rollback de esquema no debería apagar una pantalla en
 * uso. Para quitarlo, hacerlo desde `/admin/roles`.
 */
exports.down = async function () {
  console.log('[grant_quotes_permissions] down: no-op');
};
