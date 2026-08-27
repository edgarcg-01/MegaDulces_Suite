'use strict';
/**
 * `[ID.3]` — Materialización del alcance vigente (Fase ID / ADR-050).
 *
 * El corazón de la fase, y el paso que evita el apagón. `[ID.1]` creó las tablas
 * vacías y `[ID.2]` el resolver (que es **fail-closed**: sin fila = `none`). Si
 * `[ID.4]` empezara a aplicar el resolver sin esto, los **83 de 117 usuarios que
 * hoy no tienen sucursal asignada** dejarían de ver todo de golpe.
 *
 * Lo que hace: traduce el comportamiento REAL de hoy a filas explícitas, sin
 * cambiarlo ni un elemento. Se verifica con
 *
 *   node database/scripts/snapshot-user-scope.js --write  base.json            (legacy)
 *   node database/scripts/snapshot-user-scope.js --compare base.json --mode scopes
 *
 * que debe dar **cero delta**.
 *
 * ── Las dos capas ─────────────────────────────────────────────────────────────
 *
 * `role_scopes` = el default, y acá SÍ cambia la política **para el futuro**:
 *   warehouse/zone → `own`. Un usuario nuevo ve SU sucursal, y si no tiene
 *   sucursal asignada no ve nada — que es justo lo que fuerza a asignarla. Hoy
 *   pasaba al revés: nacía viendo la red completa (las 22 altas de `[UN.10.1]`).
 *
 * `user_scopes` = los overrides que preservan a los usuarios de HOY:
 *   a los 83 sin sucursal se les escribe `all` EXPLÍCITO. Nadie pierde acceso, y
 *   el privilegio deja de ser invisible: queda contable, listable y recortable
 *   uno por uno desde `/admin/usuarios`. Eso es el entregable real de esta
 *   migración — convertir un default silencioso en una lista de 83 pendientes.
 *
 * ── Fidelidad por dimensión (reglas leídas del código, no supuestas) ──────────
 *   warehouse    `users.warehouse_code` si está, si no TODAS
 *                (store-analytics.controller: `user?.warehouse_code || query`)
 *   zone         `users.zona_id` si está, si no TODAS
 *                (commercial-map.service.getRequesterZonaId)
 *   route        `trade.vendor_sales_routes` está VACÍA → hoy todos ven todas
 *   brand        filas en `commercial.promoter_brands`; sin filas, todas
 *                (promoter-brands.service: "si tiene marcas es promotor")
 *   expense_area ya es fail-closed: array vacío = ninguna, salvo
 *                `FINANCE_EXPENSES_VER_ALL` (2 roles en prod)
 *   customer     `users.customer_id` si está (portal B2B), si no todos
 *
 * Los roles de plataforma (`superadmin`/`admin`) NO llevan filas: el resolver
 * les da `all` en todo por `isPlatformAdminRole`, igual que `manage:all`. Poner
 * filas sería ruido que nadie lee.
 *
 * Idempotente (`ON CONFLICT DO NOTHING`): no pisa lo que un humano ya haya
 * ajustado a mano. No toca permisos. No requiere re-login.
 *
 * @param { import("knex").Knex } knex
 */

// Espeja PLATFORM_ADMIN_ROLES de libs/platform-core/.../ability.factory.ts
const GOD = ['superadmin', 'admin'];
const NOTA_ALL =
  '[ID.3] Materializa el acceso amplio IMPLÍCITO que este usuario ya tenía ' +
  '(convención vieja "sin sucursal = ve todas"). Candidato a recortar.';

exports.up = async function up(knex) {
  const godSql = `(${GOD.map(() => '?').join(',')})`;

  // ── 1. Defaults por ROL ───────────────────────────────────────────────────
  // warehouse/zone = `own` (fail-closed para las altas nuevas).
  // route/brand = `all` (fiel: hoy no se aplican en ningún lado).
  // expense_area = `all` solo si el rol tiene FINANCE_EXPENSES_VER_ALL.
  // customer = `own` si es rol de portal, `all` si no.
  const roles = await knex.raw(
    `SELECT tenant_id, role_name,
            COALESCE((permissions->>'FINANCE_EXPENSES_VER_ALL')::boolean, false) AS gastos_all,
            COALESCE((permissions->>'PORTAL_B2B_ACCESS')::boolean, false) AS portal
       FROM identity.role_permissions
      WHERE deleted_at IS NULL AND lower(role_name) NOT IN ${godSql}`,
    GOD,
  );

  let nRol = 0;
  for (const r of roles.rows) {
    const filas = [
      ['warehouse', 'own', null],
      ['zone', 'own', null],
      ['route', 'all', null],
      ['brand', 'all', null],
      ['expense_area', r.gastos_all ? 'all' : 'none', null],
      ['customer', r.portal ? 'own' : 'all', null],
    ];
    for (const [dim, mode, values] of filas) {
      const res = await knex.raw(
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, mode, values, nota)
         VALUES (?, ?, ?, ?, ?::text[], ?)
         ON CONFLICT (tenant_id, role_name, dimension) DO NOTHING`,
        [r.tenant_id, r.role_name, dim, mode, values, '[ID.3] default materializado del comportamiento vigente'],
      );
      nRol += res.rowCount ?? 0;
    }
  }
  console.log(`[id_materialize] role_scopes: ${nRol} filas (${roles.rows.length} roles × 6 dimensiones)`);

  // ── 2. Overrides que preservan a los usuarios de HOY ──────────────────────

  // warehouse: sin código → veía TODAS. Se escribe `all` explícito.
  const wh = await knex.raw(
    `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, nota)
     SELECT u.tenant_id, u.id, 'warehouse', 'all', ?
       FROM identity.users u
      WHERE u.deleted_at IS NULL
        AND u.warehouse_code IS NULL
        AND lower(u.role_name) NOT IN ${godSql}
     ON CONFLICT (tenant_id, user_id, dimension) DO NOTHING`,
    [NOTA_ALL, ...GOD],
  );
  console.log(`[id_materialize] user_scopes warehouse=all (sin sucursal asignada): ${wh.rowCount ?? 0}`);

  // zone: misma historia.
  const zn = await knex.raw(
    `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, nota)
     SELECT u.tenant_id, u.id, 'zone', 'all', ?
       FROM identity.users u
      WHERE u.deleted_at IS NULL
        AND u.zona_id IS NULL
        AND lower(u.role_name) NOT IN ${godSql}
     ON CONFLICT (tenant_id, user_id, dimension) DO NOTHING`,
    [NOTA_ALL, ...GOD],
  );
  console.log(`[id_materialize] user_scopes zone=all (sin zona asignada): ${zn.rowCount ?? 0}`);

  // brand: quien tiene marcas asignadas es promotor y solo ve las suyas.
  const br = await knex.raw(
    `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values, nota)
     SELECT u.tenant_id, u.id, 'brand', 'listed',
            array_agg(DISTINCT pb.brand_id::text),
            '[ID.3] Promotor de marca: espeja commercial.promoter_brands'
       FROM identity.users u
       JOIN commercial.promoter_brands pb ON pb.user_id = u.id AND pb.tenant_id = u.tenant_id
      WHERE u.deleted_at IS NULL AND lower(u.role_name) NOT IN ${godSql}
      GROUP BY u.tenant_id, u.id
     ON CONFLICT (tenant_id, user_id, dimension) DO NOTHING`,
    GOD,
  );
  console.log(`[id_materialize] user_scopes brand=listed (promotores): ${br.rowCount ?? 0}`);

  // expense_area: la única dimensión que YA era fail-closed. Se respeta tal cual.
  const ea = await knex.raw(
    `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values, nota)
     SELECT u.tenant_id, u.id, 'expense_area', 'listed',
            ARRAY(SELECT x::text FROM unnest(u.finance_expense_area_ids) x),
            '[ID.3] Espeja users.finance_expense_area_ids'
       FROM identity.users u
      WHERE u.deleted_at IS NULL
        AND u.finance_expense_area_ids IS NOT NULL
        AND array_length(u.finance_expense_area_ids, 1) > 0
        AND lower(u.role_name) NOT IN ${godSql}
     ON CONFLICT (tenant_id, user_id, dimension) DO NOTHING`,
    GOD,
  );
  console.log(`[id_materialize] user_scopes expense_area=listed: ${ea.rowCount ?? 0}`);

  // customer: por si algún usuario NO-portal tiene customer_id (hoy los 3 son
  // customer_b2b y el default del rol ya los cubre, pero la regla vieja es
  // "customer_id gana" y no se asume que eso no cambie).
  const cu = await knex.raw(
    `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, nota)
     SELECT u.tenant_id, u.id, 'customer', 'own',
            '[ID.3] Tiene customer_id: la regla vieja lo acotaba a ese cliente'
       FROM identity.users u
       JOIN identity.role_permissions rp
         ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(u.role_name)
      WHERE u.deleted_at IS NULL
        AND u.customer_id IS NOT NULL
        AND COALESCE((rp.permissions->>'PORTAL_B2B_ACCESS')::boolean, false) IS FALSE
        AND lower(u.role_name) NOT IN ${godSql}
     ON CONFLICT (tenant_id, user_id, dimension) DO NOTHING`,
    GOD,
  );
  console.log(`[id_materialize] user_scopes customer=own (no-portal con customer_id): ${cu.rowCount ?? 0}`);

  // ── 3. La foto de la deuda ────────────────────────────────────────────────
  const deuda = await knex.raw(
    `SELECT dimension, count(*) n FROM identity.user_scopes
      WHERE mode = 'all' GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log('[id_materialize] alcance AMPLIADO explícito (lo que queda por recortar):');
  deuda.rows.forEach((r) => console.log(`  ${r.dimension}: ${r.n} usuario(s)`));
  const tot = await knex.raw(`SELECT count(*) n FROM identity.user_scopes`);
  console.log(`[id_materialize] total user_scopes: ${tot.rows[0].n}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  // Solo borra lo que ESTA migración escribió (marcado en `nota`), para no
  // tirar los ajustes que un humano haya hecho después desde /admin/usuarios.
  const u = await knex.raw(`DELETE FROM identity.user_scopes WHERE nota LIKE '[ID.3]%'`);
  const r = await knex.raw(`DELETE FROM identity.role_scopes WHERE nota LIKE '[ID.3]%'`);
  console.log(`[id_materialize] down: ${u.rowCount ?? 0} user_scopes + ${r.rowCount ?? 0} role_scopes`);
};
