'use strict';
/**
 * `[MS.1.4]` — Reparte `SERVICIO_REPORTAR` / `SERVICIO_ATENDER` / `SERVICIO_COORDINAR` (ADR-081).
 *
 * **La lección LC.6.2, aplicada ANTES de que vuelva a pasar:** un módulo no está entregado hasta que
 * su permiso está REPARTIDO, no sólo declarado en el enum. `FISCAL_PURCHASE_BOOK_*` nació con su
 * módulo, nadie lo repartió, y estuvo en producción sin que NADIE pudiera abrirlo salvo por
 * `ALL_PERMS`. `test-newdb-permission-delivery.js` lo exige: toda clave del enum la concede algún rol
 * o está en `SIN_REPARTIR` con motivo y dueño.
 *
 * ── REPORTAR → a TODO rol con personas, derivado del estado vivo ─────────────────────────────
 * «Todos los usuarios pueden reportar» (pedido del 2026-10-01). Se reparte a todo rol que no sea:
 *   · `retirado_*`          — roles dados de baja; darles un permiso nuevo es ruido que hay que limpiar.
 *   · `customer_b2b`        — el cliente del portal no es personal de la empresa y no entra a la suite.
 *   · `servicio`            — la cuenta de los feeds (`kind=servicio`): no tiene login interactivo.
 *   · cuentas COMPARTIDAS de dispositivo (`checador_kiosco`, `verificador_precios`, `etiquetas_tienda`):
 *     no hay una persona detrás, y un ticket sin persona no se puede atender ni confirmar.
 *
 * ── ATENDER y COORDINAR → sólo los roles de Sistemas, NO se infiere de nadie más ─────────────
 * Quién atiende y quién coordina es DECISIÓN DE NEGOCIO (P4: Jorge Rubio · Edgar · Frank) y todavía
 * falta confirmar el ROL REAL de cada persona contra el padrón de prod — no se pudo leer desde
 * desarrollo. Repartir por un permiso vecino barrería a todo puesto administrativo: es justo el modo
 * de falla que `[SN.30]` vino a corregir (colas ofrecidas a gente que no responde de ellas).
 * Por eso van sólo a `superadmin` y `sistemas`, y **la asignación por persona** (Frank, de otro
 * departamento) se hace DESPUÉS, por `identity.user_permissions` con nota, desde `/admin/usuarios`,
 * cuando Edgar confirme los roles. La migración imprime a cuántas personas activas alcanza cada rol.
 *
 * ⛔ NO usa el operador `?` de JSONB (knex no lo escapa): `permissions -> 'KEY' IS NULL`. Sólo AGREGA
 * donde la clave falta, así que a quien alguien ya se la puso en `false` a mano NO se le pisa.
 * Alcance por `role_name` sin filtrar `tenant_id`: es un cambio del CATÁLOGO de roles (el seed define
 * los mismos roles para cada tenant), igual que los demás backfills.
 *
 * ⚠️ Después de aplicarla los usuarios afectados tienen que **volver a entrar**: los permisos viajan
 * dentro del JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */

/** Roles que NO reciben `SERVICIO_REPORTAR`, con el motivo (ver encabezado). */
const SIN_REPORTAR = ['customer_b2b', 'servicio', 'checador_kiosco', 'verificador_precios', 'etiquetas_tienda'];

/** Roles que atienden y coordinan por defecto. El resto se asigna por persona. */
const ROLES_SISTEMAS = ['superadmin', 'sistemas'];

/** `?,?,?` para una lista: knex EXPANDE un arreglo en varios `?`, así que `?::text[]` no sirve. */
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  const rep = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"SERVICIO_REPORTAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name NOT IN (${marcas(SIN_REPORTAR)})
        AND deleted_at IS NULL
        AND permissions -> 'SERVICIO_REPORTAR' IS NULL`,
    SIN_REPORTAR,
  );

  const ate = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"SERVICIO_ATENDER": true}'::jsonb
      WHERE role_name IN (${marcas(ROLES_SISTEMAS)})
        AND deleted_at IS NULL
        AND permissions -> 'SERVICIO_ATENDER' IS NULL`,
    ROLES_SISTEMAS,
  );

  const coo = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"SERVICIO_COORDINAR": true}'::jsonb
      WHERE role_name IN (${marcas(ROLES_SISTEMAS)})
        AND deleted_at IS NULL
        AND permissions -> 'SERVICIO_COORDINAR' IS NULL`,
    ROLES_SISTEMAS,
  );

  // eslint-disable-next-line no-console
  console.log(`  [MS.1.4] permisos repartidos — REPORTAR: ${rep.rowCount} · ATENDER: ${ate.rowCount} · COORDINAR: ${coo.rowCount} filas de role_permissions`);

  // Cobertura REAL: a cuántas personas activas alcanza cada clave. Lo que no se pudo medir se DECLARA.
  for (const clave of ['SERVICIO_REPORTAR', 'SERVICIO_ATENDER', 'SERVICIO_COORDINAR']) {
    const r = await knex.raw(
      `SELECT count(DISTINCT u.id)::int AS personas, count(DISTINCT rp.role_name)::int AS roles
         FROM identity.role_permissions rp
         JOIN identity.users u ON u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
        WHERE (rp.permissions ->> ?)::boolean IS TRUE
          AND u.activo IS TRUE AND u.deleted_at IS NULL`,
      [clave],
    );
    const { personas, roles } = r.rows[0];
    // eslint-disable-next-line no-console
    console.log(`  [MS.1.4]   ${clave.padEnd(20)} → ${String(roles).padStart(2)} rol(es) · ${String(personas).padStart(4)} persona(s) activa(s)`);
  }
  const sinSistemas = await knex('identity.role_permissions').where('role_name', 'sistemas').whereNull('deleted_at').first('role_name');
  if (!sinSistemas) {
    // eslint-disable-next-line no-console
    console.log('  [MS.1.4] ⚠️ el rol "sistemas" NO existe en esta base: ATENDER/COORDINAR sólo alcanzan a superadmin. Se asignan por persona (identity.user_permissions).');
  }
};

exports.down = async function down(knex) {
  for (const k of ['SERVICIO_REPORTAR', 'SERVICIO_ATENDER', 'SERVICIO_COORDINAR']) {
    await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - '${k}' WHERE permissions -> '${k}' IS NOT NULL`);
  }
};
