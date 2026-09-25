/**
 * CS.2 — Reparte `FINANCE_CAOS_VER` (reporte de la caja fuerte CAOS).
 *
 * Lección LC.6.2 / CG.14, aplicada de una: un módulo no está entregado hasta que su permiso está
 * REPARTIDO, no sólo declarado en el enum.
 *
 * **A quién, derivado del estado vivo — no inventado.** CAOS es efectivo, del mismo dominio que
 * Caja General: quien ya VE Caja General (o la GESTIONA) es exactamente quien debe ver la caja
 * fuerte. Se deriva de `FINANCE_CAJA_VER`/`_GESTIONAR` (repartidos en `20260918170000`).
 *
 * Sólo lectura: hay un único permiso. Idempotente y NO destructiva (`-> 'KEY' IS NULL`, no el
 * operador `?` de JSONB que knex no escapa bien). `retirado_*` fuera. Alcance por `role_name`.
 *
 * ⚠️ Los usuarios afectados tienen que volver a entrar: el permiso viaja en el JWT.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"FINANCE_CAOS_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND permissions -> 'FINANCE_CAOS_VER' IS NULL
        AND ( (permissions ->> 'FINANCE_CAJA_VER')::boolean IS TRUE
           OR (permissions ->> 'FINANCE_CAJA_GESTIONAR')::boolean IS TRUE )`);

  // eslint-disable-next-line no-console
  console.log(`[CS.2] FINANCE_CAOS_VER repartido: ${ver.rowCount} filas de role_permissions`);
};

exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_CAOS_VER'`);
};
