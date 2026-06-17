"use strict";

/**
 * Verificación READ-ONLY: compara los roles de campo en prod contra el seed
 * canónico (database/seeds-newdb/02_mega_dulces_initial_roles.js).
 * Reporta qué permisos esperados=true están en false/ausente en prod.
 *
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/verify-vendor-role.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

// Permisos que el seed pone en `true` para cada rol (fuente: 02_mega_dulces_initial_roles.js).
const EXPECTED = {
  vendedor: [
    'REPORTES_VER_PROPIO', 'VISITAS_REGISTRAR', 'VISITAS_VER', 'TIENDAS_VER', 'TIENDAS_CREAR',
    'SCORING_CONFIG_VER', 'VER_SEGUIMIENTO', 'CAPTURE_TICKET_USE', 'ROUTE_TICKET_CAPTURE',
    'COMMERCIAL_CUSTOMERS_VER', 'COMMERCIAL_PRICING_VER', 'COMMERCIAL_INVENTORY_VER',
    'COMMERCIAL_ORDERS_VER', 'COMMERCIAL_ORDERS_CREAR', 'COMMERCIAL_PAYMENTS_REGISTRAR',
  ],
  colaborador: [
    'REPORTES_VER_PROPIO', 'VISITAS_REGISTRAR', 'VISITAS_VER', 'TIENDAS_VER', 'TIENDAS_CREAR',
    'SCORING_CONFIG_VER', 'VER_SEGUIMIENTO',
    'COMMERCIAL_CUSTOMERS_VER', 'COMMERCIAL_PRICING_VER', 'COMMERCIAL_INVENTORY_VER',
    'COMMERCIAL_INVENTORY_CONTAR', 'COMMERCIAL_ORDERS_VER', 'COMMERCIAL_ORDERS_CREAR',
    'COMMERCIAL_PAYMENTS_REGISTRAR',
  ],
};

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  for (const [role, expected] of Object.entries(EXPECTED)) {
    const r = await c.query(
      `SELECT permissions FROM public.role_permissions WHERE role_name = $1 AND deleted_at IS NULL LIMIT 1`,
      [role],
    );
    if (!r.rows.length) { console.log(`\n[${role}] NO EXISTE en role_permissions`); continue; }
    const perms = r.rows[0].permissions || {};
    const missing = expected.filter((p) => perms[p] !== true);
    const trueCount = Object.values(perms).filter((v) => v === true).length;
    console.log(`\n[${role}] ${trueCount} permisos en true | esperados ${expected.length}`);
    if (!missing.length) {
      console.log('  ✓ todos los permisos esperados están en true');
    } else {
      console.log(`  ✗ FALTAN ${missing.length} (esperado true, en prod false/ausente):`);
      for (const p of missing) console.log(`      ${p} = ${JSON.stringify(perms[p])}`);
    }
  }

  // Cuántos usuarios afectados por rol vendedor
  const u = await c.query(
    `SELECT role_name, count(*)::int as n FROM public.users
     WHERE deleted_at IS NULL AND role_name IN ('vendedor','colaborador','supervisor_ventas')
     GROUP BY role_name ORDER BY role_name`,
  );
  console.log('\n=== usuarios por rol ===');
  for (const row of u.rows) console.log(`   ${row.role_name}: ${row.n}`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
