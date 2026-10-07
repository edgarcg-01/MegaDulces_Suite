/**
 * RD.4 — reparte `LOGISTICS_ROUTE_EXPENSES_VER` y `LOGISTICS_ROUTE_EXPENSES_GESTIONAR`.
 *
 * Un módulo no está entregado hasta que su permiso está REPARTIDO, no sólo declarado en el
 * enum (lección LC.6.2). La migración falla si nadie queda con acceso.
 *
 * A diferencia de las comisiones (RD.6), esto NO es nómina: es el gasto de la flota, del
 * mismo tenor que lo que ya se ve en `/logistica/fleet` y `/logistica/costs`. Por eso acá sí
 * se ancla, y el ancla natural es la flotilla:
 *
 *   VER        ← LOGISTICS_FLEET_VER
 *   GESTIONAR  ← LOGISTICS_FLEET_GESTIONAR
 *
 * `retirado_*` fuera. Los demás reciben la clave en `false` explícito — sin la clave,
 * /admin/roles no la muestra y nadie puede concederla desde la UI.
 *
 * Idempotente por `-> 'KEY' IS NULL`. El frontend gatea por JWT → hace falta **re-login**.
 *
 * @param { import("knex").Knex } knex
 */
const PARES = [
  ['LOGISTICS_ROUTE_EXPENSES_VER', 'LOGISTICS_FLEET_VER'],
  ['LOGISTICS_ROUTE_EXPENSES_GESTIONAR', 'LOGISTICS_FLEET_GESTIONAR'],
];

exports.up = async function up(knex) {
  for (const [key, anchor] of PARES) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                COALESCE((permissions->>'${anchor}')::boolean, false))
        WHERE permissions -> '${key}' IS NULL
          AND role_name NOT LIKE 'retirado_%'`,
    );
    console.log(`[route_expenses_perm_backfill] ${key} (<- ${anchor}): ${res.rowCount ?? 0} filas`);
  }
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE permissions->'LOGISTICS_ROUTE_EXPENSES_VER' = 'true'::jsonb ORDER BY 1`,
  );
  console.log(`[route_expenses_perm_backfill] roles que VEN el gasto de flota: ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  if (!rows.length) throw new Error('Ningún rol quedó con LOGISTICS_ROUTE_EXPENSES_VER — el módulo nacería inaccesible (LC.6.2)');
};

exports.down = async function down(knex) {
  for (const [key] of PARES) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`);
  }
  console.log('[route_expenses_perm_backfill] down: claves removidas');
};
