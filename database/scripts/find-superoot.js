const knex = require('knex');
const db = knex({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }, pool: { min: 1, max: 2 } });
(async () => {
  try {
    const r = await db('users').whereILike('username', '%super%').orWhereILike('role_name', '%admin%').select('username', 'role_name').limit(10);
    console.log(JSON.stringify(r, null, 2));
    const roles = await db('role_permissions').select('role_name').orderBy('role_name');
    console.log('\nRoles:', roles.map(r => r.role_name).join(', '));
  } finally { await db.destroy(); }
})();
