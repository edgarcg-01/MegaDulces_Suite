'use strict';
/**
 * `[RE.30]` — Reparte los permisos de Obligaciones a proveedor y el nuevo `COMPRAS_PLAZOS_AUTORIZAR`.
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────
 * `COMPRAS_OBLIGACIONES_VER/_GESTIONAR` nacieron en la Fase TP y **nunca se repartieron**. Medido
 * en prod el 2026-09-29 con el candado del proyecto (`database/tests/test-newdb-permission-delivery.js`):
 *   `[1] ✗ 4 clave(s) que NINGUN rol menciona: … COMPRAS_OBLIGACIONES_VER, COMPRAS_OBLIGACIONES_GESTIONAR`
 * → `/compras/obligaciones` y `/compras/cuentas-pago` sólo los abre el superadmin. Mismo defecto
 * que LC.6.2 y CV.24: declararlo en el enum no es entregarlo.
 *
 * ── Quién hace qué (Francisco, 2026-09-29) — y por qué son DOS llaves ────────────────────
 *   · El **plazo pactado** con el proveedor lo negocian el **comprador** o **dirección**.
 *   · Cuando una factura llega con plazo adicional, quien **extiende** esa factura es el
 *     **auxiliar de compras** — opera, no negocia.
 * Si fijar el plazo colgara de `_GESTIONAR`, darle al auxiliar lo que necesita para operar le
 * daría también la negociación. Por eso `COMPRAS_PLAZOS_AUTORIZAR` es llave aparte (el guard es
 * por clave exacta, GOTCHAS §4) y queda fuera de los presets, como `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`.
 *
 * ── Reparto, verificado contra las PERSONAS activas de prod (no sólo el nombre del rol) ──
 *   rol                   personas (puesto)                              VER  GESTIONAR  PLAZOS
 *   gerente_compras       1 (gerente_compras)                             ✓      ✓        ✓
 *   compras               2 (comprador · auxiliar_compras)                ✓      ✓        ✓
 *   auxiliar_compras      4 (3 auxiliar_compras · 1 analista abastec.)    ✓      ✓        —
 *   direccion             2 (direccion)                                   ✓      —        ✓
 *   compras_operaciones   1 (encargado_operaciones, sucursal 08)          —      —        —
 *
 *   · `compras_operaciones` queda FUERA: su única persona es staff de zona; su trabajo (confirmar
 *     la recepción física) llega con RE.31 y su propia llave.
 *   · ⚠️ **Declarado, no resuelto acá:** el rol `compras` incluye a una persona cuyo PUESTO es
 *     auxiliar de compras (`rafael_quirino`). Por rol recibe `PLAZOS_AUTORIZAR`. Si no debe
 *     negociar plazos, se le cambia el rol en `/admin/personas` — es decisión de negocio, no de
 *     esta migración (el permiso se da por rol; recortarlo por persona escondería el desajuste).
 *   · ⚠️ **Declarado, roles SECUNDARIOS (`identity.user_roles`):** `jesus_carrillo` (jefe de
 *     Finanzas, rol principal `finanzas_operativo`) tiene como adicionales `compras`,
 *     `gerente_compras`, `direccion`, `auxiliar_compras` y `compras_operaciones` → recibe también
 *     `_GESTIONAR` y `PLAZOS_AUTORIZAR`, y además es receptor válido de entregas. El servicio impide
 *     que una misma persona entregue y reciba LA MISMA entrega; la separación completa (que no
 *     opere los dos lados) es decisión del PM. Medido en prod el 2026-09-29.
 *
 * ── Mecánica (misma que `20260915130000_grant_payment_calendar_autorizar.js`) ───────────
 *   · Idempotente por `permissions -> 'KEY' IS NULL`: un `false` puesto a mano en `/admin/roles`
 *     NO se pisa (revisión PR #100).
 *   · Se apunta por `id` de fila, no por `role_name` (un rol tiene filas en varios tenants).
 *   · Imprime cuántas PERSONAS quedan con cada llave, no cuántos roles (`[2b]` del candado: un
 *     rol vacío no alcanza a nadie).
 *   · `SET LOCAL lock_timeout = '3s'` (GOTCHAS §38): los `UPDATE` toman lock de fila en
 *     `identity.role_permissions`, que el login lee; si una edición desde `/admin/roles` lo tiene
 *     tomado, el peor caso es un reintento (`55P03`), no una cola que frene los logins.
 *   · Requiere RE-LOGIN: los permisos viajan en el JWT.
 *   · Después de aplicarla, el candado `[1]` deja de listar `COMPRAS_OBLIGACIONES_*`.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[re30_grant_compras_obligaciones]';
const GRANTS = {
  COMPRAS_OBLIGACIONES_VER: ['gerente_compras', 'compras', 'auxiliar_compras', 'direccion'],
  COMPRAS_OBLIGACIONES_GESTIONAR: ['gerente_compras', 'compras', 'auxiliar_compras'],
  COMPRAS_PLAZOS_AUTORIZAR: ['gerente_compras', 'compras', 'direccion'],
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const { rows: ur } = await knex.raw(`SELECT to_regclass('identity.user_roles') IS NOT NULL AS ok`);
  const hasUserRoles = !!ur[0]?.ok;
  for (const [perm, roles] of Object.entries(GRANTS)) {
    const { rows } = await knex.raw(
      `SELECT id, role_name, permissions -> ?::text AS ya
         FROM identity.role_permissions
        WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL`,
      [perm, roles],
    );
    const nuevos = rows.filter((r) => r.ya === null);
    const enFalse = rows.filter((r) => r.ya === false).map((r) => r.role_name);
    const faltan = roles.filter((r) => !rows.some((x) => x.role_name.toLowerCase() === r));

    if (nuevos.length) {
      const res = await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions || ?::jsonb, updated_at = now()
          WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
        [JSON.stringify({ [perm]: true }), nuevos.map((r) => r.id), perm],
      );
      console.log(`${TAG} ${perm} otorgado en ${res.rowCount ?? 0} fila(s): ${nuevos.map((r) => r.role_name).join(', ')}`);
    } else {
      console.log(`${TAG} ${perm}: ningún rol nuevo por tocar.`);
    }
    if (enFalse.length) console.log(`${TAG} ${perm} en false (decisión manual, NO se pisa): ${enFalse.join(', ')}`);
    if (faltan.length) console.log(`${TAG} ${perm}: roles inexistentes en este entorno (se omiten): ${faltan.join(', ')}`);

    const { rows: cob } = await knex.raw(
      // Rol principal + roles adicionales (`identity.user_roles`, ID.13): la misma unión del login.
      `WITH roles AS (
         SELECT u.id AS user_id, u.tenant_id, lower(u.role_name) AS role_name FROM identity.users u
         ${hasUserRoles ? 'UNION SELECT ur.user_id, ur.tenant_id, lower(ur.role_name) FROM identity.user_roles ur' : ''}
       )
       SELECT count(DISTINCT u.id)::int AS personas
         FROM identity.role_permissions rp
         JOIN roles r ON r.tenant_id = rp.tenant_id AND r.role_name = lower(rp.role_name)
         JOIN identity.users u ON u.id = r.user_id
        WHERE rp.deleted_at IS NULL AND u.deleted_at IS NULL AND u.activo
          AND (rp.permissions->>?::text)::boolean IS TRUE`,
      [perm],
    );
    console.log(`${TAG} ${perm}: ${cob[0].personas} persona(s) activa(s) la tienen — deben RE-LOGUEAR`);
  }

  // Control de separación de funciones: el auxiliar opera, no fija plazos.
  const { rows: leak } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE deleted_at IS NULL AND lower(role_name) IN ('auxiliar_compras','compras_operaciones')
        AND (permissions->>'COMPRAS_PLAZOS_AUTORIZAR')::boolean IS TRUE`,
  );
  if (leak.length) console.warn(`${TAG} ⚠️ roles operativos con PLAZOS_AUTORIZAR (revisar separación de funciones): ${leak.map((r) => r.role_name).join(', ')}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  // Quita SÓLO lo que esta migración pudo poner (true en estos roles). Un false manual se respeta,
  // y un true en otro rol (puesto a mano en /admin/roles) no se toca.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  for (const [perm, roles] of Object.entries(GRANTS)) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions - ?::text, updated_at = now()
        WHERE lower(role_name) = ANY(?::text[]) AND deleted_at IS NULL
          AND (permissions->>?::text)::boolean IS TRUE`,
      [perm, roles, perm],
    );
  }
};
