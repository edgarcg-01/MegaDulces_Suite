/**
 * `[CSU.6]` Da `FINANCE_CORTES_VER` a la TIENDA: `encargado_tienda` y `auxiliar_tienda`.
 *
 * Decisión de Francisco (2026-10-05): «Finanzas, todas las sucursales; encargados y auxiliares de
 * encargados, sólo su sucursal». La migración anterior (`20261005200000`) ya lo reparte a quien ve
 * Ingresos contables; ésta suma los dos roles de tienda.
 *
 * ⭐ El permiso sólo ABRE la pantalla. QUÉ sucursales ve cada persona lo decide `ScopeService`
 * (ADR-050) con `identity.role_scopes`: la tienda tiene `warehouse = own` (su `warehouse_code`) y
 * Finanzas `all`. Por eso no hace falta un `_VER_ALL`. Medido en prod con el servicio real: los 7
 * encargados y 4 de los 5 auxiliares resuelven su propia sucursal; `yadira_campero` no tiene
 * `warehouse_code` y la pantalla le dice que no tiene sucursal asignada.
 *
 * Va aparte de `20261005200000` a propósito: aquélla ya está en `main` y no se modifica.
 *
 * ⚠️ NO pisa un `false` explícito. Se pregunta con `permissions -> 'KEY' IS NULL`, NO con el
 * operador `?` de JSONB (knex no lo escapa bien). Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const ROLES = ['encargado_tienda', 'auxiliar_tienda'];

exports.up = async function (knex) {
  const tabla = await knex.raw(`SELECT to_regclass('identity.role_permissions') AS t`);
  if (!tabla.rows[0]?.t) return; // entorno sin el módulo de identidad

  // `role_permissions` es tabla viva (cada login la lee): esperar poco y fallar, no formar fila.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const { rows } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"FINANCE_CORTES_VER": true}'::jsonb
      WHERE lower(role_name) = ANY(?::text[])
        AND permissions -> 'FINANCE_CORTES_VER' IS NULL
     RETURNING role_name`,
    [ROLES],
  );

  if (rows?.length) {
    // eslint-disable-next-line no-console
    console.log(`  [CSU.6] FINANCE_CORTES_VER otorgado a ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ')}`);
  }
};

exports.down = async function (knex) {
  const tabla = await knex.raw(`SELECT to_regclass('identity.role_permissions') AS t`);
  if (!tabla.rows[0]?.t) return;
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  // Sólo quita lo que esta migración pudo haber dado: el `true` de los dos roles de tienda.
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - 'FINANCE_CORTES_VER'
      WHERE lower(role_name) = ANY(?::text[])
        AND (permissions -> 'FINANCE_CORTES_VER')::text = 'true'`,
    [ROLES],
  );
};
