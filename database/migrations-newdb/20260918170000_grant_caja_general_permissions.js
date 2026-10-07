/**
 * CG.14 — Reparte `FINANCE_CAJA_VER` / `_GESTIONAR` / `_AUTORIZAR` (ADR-070).
 *
 * **La lección LC.6.2, aplicada ANTES de que vuelva a pasar:** un módulo no está entregado
 * hasta que su permiso está REPARTIDO, no sólo declarado en el enum. Ahí el par
 * `FISCAL_PURCHASE_BOOK_*` nació con el módulo, nadie lo repartió, y el módulo estuvo en
 * producción sin que NADIE pudiera abrirlo salvo por `ALL_PERMS`.
 *
 * **A quién, derivado del estado vivo — no inventado.** Hasta hoy los 15 endpoints de
 * `/finanzas/caja` colgaban de `FINANCE_BANK_VER`, que es de Bancos: la gente que ya opera
 * la caja es exactamente la que hoy tiene Bancos. Medido el 2026-09-18 sobre 37 roles vivos:
 *
 *   FINANCE_BANK_VER            true en 11 roles  (auditor_externo, auxiliar finanzas,
 *                                                  contabilidad, credito_cobranza, direccion,
 *                                                  finanzas, finanzas_operativo,
 *                                                  gerente_compras, marketing, superadmin,
 *                                                  tesoreria)
 *   FINANCE_BANK_GESTIONAR      true en  9 roles  (los mismos sin auditor_externo ni direccion,
 *                                                  que quedan de lectura)
 *   FINANCE_PAYMENT_CALENDAR_AUTORIZAR true en 2  (direccion, superadmin)
 *
 * · VER       → quien ya VE Bancos, o quien ya lo GESTIONA (gestionar implica ver, y la ruta
 *               se gatea con VER — de ahí el OR).
 * · GESTIONAR → quien ya GESTIONA Bancos. Capturar efectivo es del mismo peso que
 *               reclasificar un movimiento bancario.
 * · AUTORIZAR → se calca `FINANCE_PAYMENT_CALENDAR_AUTORIZAR`, el otro permiso restringido de
 *               Finanzas. **Capturar ≠ autorizar** (§CG.15): quien cierra el corte no es quien
 *               lo llenó. Por eso NO se deriva de GESTIONAR.
 *
 * **Los `retirado_*` NO**, a propósito: son roles dados de baja y darles un permiso nuevo es
 * ruido que después hay que limpiar.
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

exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"FINANCE_CAJA_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'FINANCE_CAJA_VER' IS NULL
        AND ( (permissions ->> 'FINANCE_BANK_VER')::boolean IS TRUE
           OR (permissions ->> 'FINANCE_BANK_GESTIONAR')::boolean IS TRUE )`);

  const ges = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"FINANCE_CAJA_GESTIONAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'FINANCE_CAJA_GESTIONAR' IS NULL
        AND (permissions ->> 'FINANCE_BANK_GESTIONAR')::boolean IS TRUE`);

  const aut = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"FINANCE_CAJA_AUTORIZAR": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'FINANCE_CAJA_AUTORIZAR' IS NULL
        AND (permissions ->> 'FINANCE_PAYMENT_CALENDAR_AUTORIZAR')::boolean IS TRUE`);

  // eslint-disable-next-line no-console
  console.log(`[CG.14] permisos repartidos — VER: ${ver.rowCount} · GESTIONAR: ${ges.rowCount} · AUTORIZAR: ${aut.rowCount} filas de role_permissions`);
};

exports.down = async function (knex) {
  for (const k of ['FINANCE_CAJA_VER', 'FINANCE_CAJA_GESTIONAR', 'FINANCE_CAJA_AUTORIZAR']) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${k}'`);
  }
};
