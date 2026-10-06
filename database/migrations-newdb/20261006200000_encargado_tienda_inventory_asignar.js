'use strict';
/**
 * `[IC.23]` — **El encargado de sucursal asigna quién cuenta.**
 *
 * Decisión de negocio (Edgar, 2026-10-06), al resolver el hallazgo de `[IC.13]`: el ritmo diario
 * de conteo lo opera la tienda, y quien arma el equipo es el **encargado de sucursal**.
 *
 * ── Por qué este permiso y no `SUPERVISAR` ───────────────────────────────────────────────────
 * `SUPERVISAR` abre `GET /commercial/inventory/counts/:id/items`, que devuelve `expected_qty`
 * — **el teórico, fila por fila**. Es la misma puerta que `[IC.2]` le quitó al `almacenista`
 * para no romper el conteo ciego. Dársela al encargado lo pondría a saber el número antes que
 * quien cuenta, que es justo lo que un conteo ciego existe para evitar.
 *
 * `ASIGNAR` es la facultad correcta: armar el equipo y mirar el avance. Los tres endpoints que
 * ese trabajo necesita y que estaban cerrados se abren en el mismo commit
 * (`:id/assignments`, `:id/progress`, `:id/aisle-teams`), y `:id/items` **se queda cerrado**.
 *
 * ── ⛔ EL DETALLE QUE VUELVE INÚTIL AL PATRÓN DE SIEMPRE ──────────────────────────────────────
 * Las migraciones de permisos de este repo sólo AGREGAN donde la clave falta
 * (`permissions -> 'KEY' IS NULL`), para no pisar lo que alguien puso a mano. **Acá eso sería un
 * no-op**: medido en prod el 2026-10-06, `encargado_tienda` ya trae
 * `COMMERCIAL_INVENTORY_ASIGNAR` en **`false` explícito** — el residuo de guardar el mapa
 * completo desde `/admin/roles`, que deja en `false` toda clave del enum que el rol no tenía
 * (la misma causa que `[LC.6.2]`). Por eso acá se escribe `true` **sin condicionar a `IS NULL`**,
 * y se acota a UN rol nombrado para que el `false` de los demás no se toque.
 *
 * ── Alcance: 7 personas, 6 sucursales ────────────────────────────────────────────────────────
 * Medido: claudia_pimentel (02), cynthia_lopez (01), luis_vazquez (06), monica_mejia (01),
 * rosaura_casias (07), tania_sanchez (05), veronica_magana (03).
 * ⚠️ **04 (Yurécuaro) y 08 (Morelia Abastos) no tienen encargado de tienda.** Ahí el ritmo
 * diario no va a tener quién asigne hasta que se cubra el puesto. Se DECLARA; no se resuelve
 * repartiendo el permiso a otro rol «parecido».
 *
 * ⚠️ `ASIGNAR` NO lleva alcance por sucursal: hoy inventario no está migrado a `ScopeService`
 * (`[ID.2]`), así que un encargado puede asignar en el folio de otra plaza. Queda declarado
 * como deuda con nombre en `FASE_IC_RITMOS_Y_ABC.md` §7 — no se simula un alcance que la capa
 * de datos todavía no aplica.
 *
 * ⚠️ Después de aplicarla, las 7 personas tienen que **volver a entrar**: los permisos viajan
 * dentro del JWT y el token ya emitido no los trae.
 *
 * Alcance por `role_name` sin filtrar `tenant_id`: es un cambio del CATÁLOGO de roles, igual
 * que los demás backfills de permisos.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'encargado_tienda';
const CLAVE = 'COMMERCIAL_INVENTORY_ASIGNAR';

exports.up = async function up(knex) {
  // El estado ANTES, para que el log diga qué se movió y no sólo que corrió.
  const antes = await knex.raw(
    `SELECT role_name, permissions -> ? AS valor
       FROM identity.role_permissions
      WHERE role_name = ?`,
    [CLAVE, ROL],
  );
  if (!antes.rows.length) {
    // Fail-fast declarado: si el rol no existe en este destino, NO se inventa la fila. Una
    // migración de permisos que crea roles silenciosamente es cómo se fabrican roles fantasma.
    // eslint-disable-next-line no-console
    console.log(`[IC.23] El rol '${ROL}' no existe en este destino; nada que repartir.`);
    return;
  }

  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ARRAY[?], 'true'::jsonb, true),
            updated_at  = now()
      WHERE role_name = ?
        AND COALESCE((permissions ->> ?)::bool, false) IS DISTINCT FROM true`,
    [CLAVE, ROL, CLAVE],
  );

  const personas = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.users WHERE role_name = ? AND activo`,
    [ROL],
  );

  // eslint-disable-next-line no-console
  console.log(
    `[IC.23] ${CLAVE} -> '${ROL}': ${r.rowCount ?? 0} fila(s) de rol actualizadas `
    + `(valor previo: ${JSON.stringify(antes.rows.map((x) => x.valor))}). `
    + `Alcanza a ${personas.rows[0]?.n ?? 0} persona(s) activa(s) — tienen que RE-LOGUEAR.`,
  );
};

/**
 * Revierte a `false`, **no borra la clave**: así quedaba antes de esta migración (explícito en
 * `false`), y dejarla ausente cambiaría el estado a uno distinto del original.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ARRAY[?], 'false'::jsonb, true),
            updated_at  = now()
      WHERE role_name = ?`,
    [CLAVE, ROL],
  );
};
