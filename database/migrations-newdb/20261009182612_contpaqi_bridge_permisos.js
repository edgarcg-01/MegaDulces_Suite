'use strict';
/**
 * `[CP.8.32]` — **Reparte `FISCAL_CONTPAQI_BRIDGE_VER` / `_GESTIONAR`.**
 *
 * ⭐ La lección de `[LC.6.2]` es el motivo de que esta migración exista: ese par de permisos nació
 * con la fase, vivió **sólo en el enum**, y el módulo estuvo en producción con **cero roles**
 * pudiendo abrirlo. *Un módulo nuevo no está entregado hasta que su permiso está REPARTIDO en
 * prod, no sólo declarado.*
 *
 * ── ⛔ Por qué NO se calca la distribución del Libro de Compras ──────────────────────────────
 * Lo natural era copiar a `FISCAL_PURCHASE_BOOK_*`, que es el módulo hermano. Leído en vivo, su
 * `VER` lo tienen **8 roles**, entre ellos `marketing`, `credito_cobranza` y `gerente_compras`.
 *
 * Esta pantalla muestra **movimientos de banco con su cuenta contable**. Copiar una distribución
 * hereda también sus errores, y ninguno de esos tres opera egresos bancarios: el de compras tiene
 * su propio proyecto, cobranza mira el otro lado del dinero y marketing no tiene por qué ver el
 * detalle de lo que sale del banco.
 *
 * ⭐ Entre quedarse corto y pasarse, **corto es el lado barato**: si a alguien le falta, lo pide y
 * se ve; si le sobra, nadie se entera. Se reparte el mínimo defendible y se amplía con nombre.
 *
 * | rol | VER | GESTIONAR | personas |
 * |---|:-:|:-:|--:|
 * | `contabilidad` | ✓ | ✓ | 4 |
 * | `finanzas` | ✓ | ✓ | 1 |
 * | `superadmin` | ✓ | ✓ | 8 |
 * | `direccion` | ✓ | — | 2 |
 * | `auditor_externo` | ✓ | — | 0 |
 *
 * `direccion` y `auditor_externo` quedan de **lectura**, igual que en el Libro de Compras: miran
 * el trámite, no lo mueven.
 *
 * ⚠️ **`GESTIONAR` se reparte aunque todavía no haya NADA que entregar** (las 21 reglas están sin
 * firmar). A propósito: el día que se firme una, la puerta de entregar ya está separada de la de
 * mirar. Repartir permisos con el botón vivo es cuando se cometen los errores.
 *
 * ── Pre-vuelo medido contra prod (2026-10-09) ───────────────────────────────────────────────
 * 56 roles, **0 con la clave** (ni siquiera en `false`), 14 `retirado_*`.
 *
 * ⚠️ Por eso acá `create_missing = true` funciona. ⛔ **No se usa el patrón
 * `permissions -> 'KEY' IS NULL`**: en `[IC.23]` ese patrón fue un **no-op** porque la clave ya
 * existía como `false` explícito (residuo de guardar el mapa completo desde `/admin/roles`). Se
 * midió que acá no pasa, y aun así el `WHERE` no filtra por ausencia: **escribe el valor que
 * corresponde**, exista o no la clave.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VER = 'FISCAL_CONTPAQI_BRIDGE_VER';
const GESTIONAR = 'FISCAL_CONTPAQI_BRIDGE_GESTIONAR';

/** rol → [ve, gestiona]. Derivado del estado vivo y recortado con motivo (ver cabecera). */
const REPARTO = [
  ['contabilidad', true, true],
  ['finanzas', true, true],
  ['superadmin', true, true],
  ['direccion', true, false],
  ['auditor_externo', true, false],
];

exports.up = async function up(knex) {
  for (const [rol, ve, gestiona] of REPARTO) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(
                              jsonb_set(permissions, ?::text[], ?::jsonb, true),
                              ?::text[], ?::jsonb, true),
              updated_at  = now()
        WHERE role_name = ?`,
      [`{${VER}}`, JSON.stringify(ve), `{${GESTIONAR}}`, JSON.stringify(gestiona), rol],
    );
  }

  /**
   * ⛔ Compuerta: si ningún rol quedó con el permiso, la migración "pasó" y el módulo sigue
   * cerrado para todos — exactamente el modo de falla de `[LC.6.2]`. Un `UPDATE` que no encuentra
   * su fila **no falla**, y eso se lee igual que un éxito.
   */
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE (permissions->>?)::boolean IS TRUE`, [VER]);
  if (!rows[0] || rows[0].n < REPARTO.length) {
    throw new Error(
      `[CP.8.32] el permiso quedó repartido a ${rows[0] ? rows[0].n : 0} roles y se esperaban `
      + `${REPARTO.length}: revisar que los nombres de rol existan antes de dar esto por hecho.`,
    );
  }
};

exports.down = async function down(knex) {
  for (const [rol] of REPARTO) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = (permissions - ?::text) - ?::text, updated_at = now()
        WHERE role_name = ?`,
      [VER, GESTIONAR, rol],
    );
  }
};
