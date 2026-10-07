/**
 * RD.6 — reparte `COMMERCIAL_COMMISSIONS_VER` y `COMMERCIAL_COMMISSIONS_GESTIONAR`.
 *
 * POR QUÉ ES UNA MIGRACIÓN Y NO SÓLO UNA CLAVE EN EL ENUM
 * Lección LC.6.2: el par `FISCAL_PURCHASE_BOOK_VER/_GESTIONAR` nació con su sprint pero
 * nunca lo repartió ni el seed ni una migración — sólo vivía en el enum. La única fila de
 * `role_permissions` con esas claves era `almacenista` **en false** (residuo de guardar el
 * mapa completo desde /admin/roles, que deja las claves nuevas del enum en false).
 * Resultado: cero roles con acceso y un módulo en prod que nadie podía abrir. Un módulo no
 * está entregado hasta que su permiso está REPARTIDO, no sólo declarado.
 *
 * POR QUÉ LISTA EXPLÍCITA Y NO UN ANCLA
 * La primera versión de esta migración anclaba a `COMMERCIAL_ANALYTICS_VER`, como hizo
 * BI.9 con las metas de venta. Medido antes de dejarlo: daba acceso a **22 roles**, entre
 * ellos `repartidor`, `telemarketing`, `compras` y once `retirado_*`. Esto no es un
 * reporte de ventas — es **nómina**: cuánto cobra por quincena cada chofer y cada
 * supervisor, con su nombre. El ancla correcta para "ve la analítica comercial" no es la
 * correcta para "ve sueldos", así que la lista va a mano y corta.
 *
 *   VER        → dirección, finanzas, contabilidad, superadmin
 *   GESTIONAR  → dirección, finanzas, superadmin   (calcular y aprobar mueve dinero)
 *
 * `contabilidad` ve pero no gestiona: le toca cuadrar el pago, no autorizarlo.
 * Los `retirado_*` quedan fuera por definición. Todos los demás roles reciben la clave en
 * `false` explícito, que es distinto de no tenerla: sin la clave, /admin/roles no la
 * muestra y nadie puede concederla desde la UI.
 *
 * Idempotente por `-> 'KEY' IS NULL`. El frontend gatea por JWT → hace falta **re-login**.
 * Verificar en prod:
 *   select role_name from role_permissions
 *    where permissions->'COMMERCIAL_COMMISSIONS_VER' = 'true'::jsonb;
 *
 * @param { import("knex").Knex } knex
 */
const VER = 'COMMERCIAL_COMMISSIONS_VER';
const GESTIONAR = 'COMMERCIAL_COMMISSIONS_GESTIONAR';

const ROLES_VER = ['direccion', 'finanzas', 'contabilidad', 'superadmin'];
const ROLES_GESTIONAR = ['direccion', 'finanzas', 'superadmin'];

/** Siembra la clave en TODOS los roles vivos: true en los de la lista, false en el resto. */
async function repartir(knex, key, roles) {
  const lista = roles.map((r) => `'${r}'`).join(',');
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('${key}', (role_name IN (${lista})))
      WHERE permissions -> '${key}' IS NULL
        AND role_name NOT LIKE 'retirado_%'`,
  );
  return res.rowCount ?? 0;
}

exports.up = async function up(knex) {
  const v = await repartir(knex, VER, ROLES_VER);
  const g = await repartir(knex, GESTIONAR, ROLES_GESTIONAR);
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE permissions->'${VER}' = 'true'::jsonb ORDER BY 1`,
  );
  console.log(`[commissions_perm_backfill] up: VER ${v} filas · GESTIONAR ${g} filas`);
  console.log(`[commissions_perm_backfill] roles que VEN comisiones: ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  if (!rows.length) throw new Error('Ningún rol quedó con COMMERCIAL_COMMISSIONS_VER — el módulo nacería inaccesible (LC.6.2)');
};

exports.down = async function down(knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${VER}' WHERE permissions -> '${VER}' IS NOT NULL`);
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${GESTIONAR}' WHERE permissions -> '${GESTIONAR}' IS NOT NULL`);
  console.log('[commissions_perm_backfill] down: claves removidas');
};
