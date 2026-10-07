/**
 * Fix de datos: alinear el case de role_name de los roles `auxiliar_*`.
 *
 * Bug en prod: las filas de `role_permissions` se crearon como
 * `Auxiliar_mercadotecnia` / `Auxiliar_sucursal` (con mayúscula inicial), pero
 * los usuarios (`users.role_name`) tienen la forma snake_case en minúscula
 * `auxiliar_mercadotecnia` / `auxiliar_sucursal` (convención del proyecto).
 * El lookup del guard/permsCache es case-sensitive (`WHERE role_name = ?`), así
 * que no encontraba la fila → 0 permisos → todos esos usuarios rebotaban a
 * `/dashboard/captures`. Afecta a 5 usuarios (gloria_garcia entre ellos).
 *
 * Fix: renombrar las filas a minúscula (forma canónica, la que ya usan los
 * users). Idempotente y sin riesgo de conflicto UNIQUE(tenant_id, role_name):
 * el UPDATE solo corre si NO existe ya la fila en minúscula.
 *
 * @param { import("knex").Knex } knex
 */
const RENAMES = [
  ['Auxiliar_mercadotecnia', 'auxiliar_mercadotecnia'],
  ['Auxiliar_sucursal', 'auxiliar_sucursal'],
];

exports.up = async function (knex) {
  for (const [from, to] of RENAMES) {
    const res = await knex.raw(
      `UPDATE role_permissions rp
          SET role_name = ?
        WHERE rp.role_name = ?
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions x
             WHERE x.tenant_id = rp.tenant_id AND x.role_name = ?
          )`,
      [to, from, to],
    );
    console.log(`[fix_auxiliar_case] "${from}" → "${to}": filas = ${res.rowCount ?? 0}`);
  }
};

/**
 * down: revertir a la forma con mayúscula (por simetría; el mismo guard NOT EXISTS).
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  for (const [from, to] of RENAMES) {
    await knex.raw(
      `UPDATE role_permissions rp
          SET role_name = ?
        WHERE rp.role_name = ?
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions x
             WHERE x.tenant_id = rp.tenant_id AND x.role_name = ?
          )`,
      [from, to, from],
    );
  }
};
