/**
 * `[AB.13]` — El almacenista entra a Autoabasto, y ve SÓLO su almacén.
 *
 * ── Lo medido en prod el 2026-10-07 (solo lectura) ─────────────────────────────────────────
 * 1. **`almacenista` no tiene `AUTOABASTO_VER`** (la clave está ausente). La migración que
 *    repartió la llave (`20260919160000`, batch 493, 21-sep) la derivó de
 *    `COMMERCIAL_INVENTORY_VER`, y el almacenista **todavía no lo tenía**: se lo dio `[IC.2]` el
 *    29-sep. O sea que el rol para el que se hizo el módulo quedó fuera por el orden de las
 *    migraciones. Repetir la misma derivación hoy alcanza a **un solo rol: `almacenista`**
 *    (6 personas) — medido, no supuesto.
 * 2. **Su regla de alcance de almacén es `all`** (`role_scopes`, área `'*'`). Con la llave, vería
 *    la red completa.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * 1. `AUTOABASTO_VER = true` con la MISMA derivación de `20260919160000` (inventario o pedido
 *    de compra a la vista, sin roles externos ni retirados). Sólo donde la clave falta: un
 *    `false` puesto a mano desde `/admin/roles` NO se pisa.
 * 2. Regla de alcance `almacenista · warehouse · área 'almacen' · own`. Por área, no `'*'`:
 *    - Autoabasto resuelve su alcance en el área **Almacén** ([AB.13], el proyecto donde vive).
 *    - Hoy **ningún otro módulo** consulta el área `almacen` (medido con grep), así que la regla
 *      no le cambia al almacenista lo que ve en ninguna otra pantalla. Su `'*'` en `all` queda
 *      intacto.
 *
 * ⚠️ `own` lee `identity.users.warehouse_code`. Medido: **5 de los 6 almacenistas no lo tienen**
 * (sólo `luis_espino` = `01`). Sin almacén en su ficha, `own` no resuelve y la mesa sale VACÍA
 * (fail-closed, ADR-050) — la pantalla lo dice. Se asigna desde `/admin/personas`, no aquí: los
 * datos de una persona se administran desde la UI.
 *
 * ⚠️ Después de aplicarla los almacenistas tienen que **volver a entrar**: el permiso viaja en el
 * JWT. La regla de alcance no lo necesita (caché de 30 s).
 *
 * Idempotente: `-> 'KEY' IS NULL` (no el operador `?`, que knex no escapa) y `ON CONFLICT DO
 * NOTHING` sobre la PK `(tenant_id, role_name, dimension, area)`.
 *
 * @param { import("knex").Knex } knex
 */

const EXTERNOS = ['customer_b2b'];
const NOTA = '[AB.13] Autoabasto: el almacenista ve sólo su almacén (área Almacén).';

exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"AUTOABASTO_VER": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name <> ALL(?)
        AND permissions -> 'AUTOABASTO_VER' IS NULL
        AND ( (permissions ->> 'COMMERCIAL_INVENTORY_VER')::boolean IS TRUE
           OR (permissions ->> 'COMPRAS_PEDIDO_VER')::boolean IS TRUE )`, [EXTERNOS]);

  const alcance = await knex.raw(
    `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, nota)
     SELECT rp.tenant_id, rp.role_name, 'warehouse', 'almacen', 'own', ?
       FROM identity.role_permissions rp
      WHERE rp.role_name = 'almacenista'
     ON CONFLICT (tenant_id, role_name, dimension, area) DO NOTHING`, [NOTA]);

  // eslint-disable-next-line no-console
  console.log(`[AB.13] AUTOABASTO_VER: ${ver.rowCount} rol(es) · alcance almacén propio: ${alcance.rowCount} fila(s)`);
};

exports.down = async function (knex) {
  await knex.raw(
    `DELETE FROM identity.role_scopes
      WHERE role_name = 'almacenista' AND dimension = 'warehouse' AND area = 'almacen' AND nota = ?`, [NOTA]);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - 'AUTOABASTO_VER'
      WHERE role_name = 'almacenista' AND (permissions ->> 'AUTOABASTO_VER')::boolean IS TRUE`);
};
