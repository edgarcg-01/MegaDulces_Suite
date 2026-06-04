const knex = require('knex');
const db = knex({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }, pool: { min: 1, max: 2 } });
(async () => {
  try {
    const r = await db('role_permissions').where({ role_name: 'customer_b2b' }).first('role_name', 'permissions');
    if (!r) { console.log('customer_b2b no encontrado'); return; }
    console.log('Rol: customer_b2b\nPermisos relevantes:');
    const keys = Object.keys(r.permissions).sort();
    const interesting = keys.filter(k => /COMMERCIAL_(PROMOTIONS|ORDERS|CUSTOMERS|TELEVENTA|RECOMMENDATIONS|PRICING|WAREHOUSES|INVENTORY|ANALYTICS)/.test(k));
    for (const k of interesting) console.log(`  ${k} = ${r.permissions[k]}`);
    console.log(`\nTotal perms: ${keys.length}`);
  } finally { await db.destroy(); }
})();
