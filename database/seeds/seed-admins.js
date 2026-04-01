const bcrypt = require('bcryptjs');
const knex = require('knex')({
  client: 'postgresql',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'trade_marketing',
    user: 'postgres',
    password: 'admin',
  }
});

async function seedUsers() {
  try {
    // 1. Insertar rol superadmin
    const existing = await knex('role_permissions').where({ role_name: 'superadmin' }).first();
    if (!existing) {
      await knex('role_permissions').insert({
        role_name: 'superadmin',
        permissions: JSON.stringify({
          users: ['create', 'read', 'update', 'delete'],
          captures: ['create', 'read', 'update', 'delete'],
          daily_captures: ['create', 'read', 'update', 'delete'],
          catalogs: ['create', 'read', 'update', 'delete'],
          reports: ['create', 'read', 'update', 'delete'],
          stores: ['create', 'read', 'update', 'delete'],
          visits: ['create', 'read', 'update', 'delete'],
          exhibitions: ['create', 'read', 'update', 'delete'],
          planograma: ['create', 'read', 'update', 'delete'],
          scoring: ['create', 'read', 'update', 'delete'],
        }),
      });
      console.log('✅ Rol superadmin creado');
    } else {
      console.log('ℹ️  Rol superadmin ya existe');
    }

    // 2. Hash passwords
    const adminHash = await bcrypt.hash('admin1', 10);
    const superootHash = await bcrypt.hash('superoot', 10);

    // 3. Insertar usuarios
    const users = [
      { username: 'admin', password_hash: adminHash, nombre: 'Administrador General', zona: 'Nacional', role_name: 'superadmin', activo: true },
      { username: 'superoot', password_hash: superootHash, nombre: 'Super Root', zona: 'Nacional', role_name: 'superadmin', activo: true },
    ];

    for (const user of users) {
      const exists = await knex('users').where({ username: user.username }).first();
      if (exists) {
        await knex('users').where({ username: user.username }).update(user);
        console.log(`🔄 Usuario "${user.username}" actualizado`);
      } else {
        await knex('users').insert(user);
        console.log(`✅ Usuario "${user.username}" creado`);
      }
    }

    console.log('\n🎉 Seed completado exitosamente');
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    await knex.destroy();
  }
}

seedUsers();
