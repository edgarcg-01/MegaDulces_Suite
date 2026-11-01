/**
 * `[COT.20]` — Quién cotiza en qué sucursales: Dirección en las 8, cada jefe de zona en las suyas.
 *
 * ── Lo medido en prod el 2026-10-30 (solo lectura) ─────────────────────────────────────────
 * 1. **`direccion` lee `all` pero escribe `none`** (`role_scopes`, área `'*'`). El cotizador valida
 *    con escritura (COT.19), así que `superuser` y `guillermo_lopez` —rol principal `direccion`,
 *    `superadmin` sólo como complemento, que el alcance no mira— ven «Sin sucursal asignada» y no
 *    pueden cotizar. `superuser` cotizó 7 veces hasta el 2-oct, antes de COT.19.
 * 2. **Los 3 jefes de zona tienen `superadmin` como rol principal** (god-mode) y cotizaban en las 8.
 *    Sus sucursales, confirmadas por Francisco: ivette_cruz 01-04 (zona La Piedad), aaron_alejo
 *    07-08 (Morelia), ramon_rodriguez 05-06 (Zamora). `trade.zones` no sirve de fuente: las
 *    sucursales de Morelia apuntan a zonas propias, no a la zona MORELIA.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * 1. `direccion · warehouse · área 'televenta' · all / all`. Por área: su `'*'` (escribir `none`)
 *    sigue igual en todos los demás módulos.
 * 2. Una regla de usuario `área 'televenta' · listed` por jefe de zona. Le gana al god-mode sólo en
 *    esa área (`ScopeService`, COT.20); en los demás módulos siguen viendo todo.
 *
 * Sin re-login: el alcance no viaja en el JWT (caché de 30 s).
 * Idempotente: `ON CONFLICT DO NOTHING` sobre las PK `(tenant_id, role_name|user_id, dimension, area)`.
 * Un jefe de zona que no exista (o esté dado de baja) simplemente no recibe fila.
 *
 * @param { import("knex").Knex } knex
 */

const NOTA = '[COT.20] Cotizaciones: sucursales en las que cotiza.';
const JEFES_DE_ZONA = {
  ivette_cruz: ['01', '02', '03', '04'],
  aaron_alejo: ['07', '08'],
  ramon_rodriguez: ['05', '06'],
};

exports.up = async function (knex) {
  const rol = await knex.raw(
    `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, mode_write, nota)
     SELECT rp.tenant_id, rp.role_name, 'warehouse', 'televenta', 'all', 'all', ?
       FROM identity.role_permissions rp
      WHERE rp.role_name = 'direccion'
     ON CONFLICT (tenant_id, role_name, dimension, area) DO NOTHING`, [NOTA]);

  let usuarios = 0;
  for (const [username, sucursales] of Object.entries(JEFES_DE_ZONA)) {
    const r = await knex.raw(
      `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, area, mode, values, nota)
       SELECT u.tenant_id, u.id, 'warehouse', 'televenta', 'listed', ?::varchar[], ?
         FROM identity.users u
        WHERE u.username = ? AND u.deleted_at IS NULL
       ON CONFLICT (tenant_id, user_id, dimension, area) DO NOTHING`, [sucursales, NOTA, username]);
    usuarios += r.rowCount;
  }

  // eslint-disable-next-line no-console
  console.log(`[COT.20] direccion en televenta: ${rol.rowCount} fila(s) · jefes de zona: ${usuarios} fila(s)`);
};

exports.down = async function (knex) {
  await knex.raw(
    `DELETE FROM identity.role_scopes WHERE dimension = 'warehouse' AND area = 'televenta' AND nota = ?`, [NOTA]);
  await knex.raw(
    `DELETE FROM identity.user_scopes WHERE dimension = 'warehouse' AND area = 'televenta' AND nota = ?`, [NOTA]);
};
