/**
 * Script to verify a user in production database
 * Usage: NODE_ENV=production node scripts/verify_user_prod.js
 */

const knex = require('knex');

// Load environment variables
require('dotenv').config();

const environment = process.env.NODE_ENV || 'production';

const config = {
  client: 'pg',
  connection: process.env.DATABASE_URL
    ? { 
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false } 
      }
    : {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: false, // Disable SSL if server doesn't support it
      },
  pool: { min: 2, max: 10 },
};

const db = knex(config);

async function verifyUser() {
  try {
    console.log(`[Script] Connecting to ${environment} database...`);
    
    // Search by name
    const usersByName = await db('users')
      .where('nombre', 'like', '%Luis Francisco López Gutierrez%')
      .select('*');
    
    if (usersByName.length > 0) {
      console.log(`[Script] Found ${usersByName.length} user(s) by name:`);
      usersByName.forEach(u => {
        console.log('---');
        console.log('ID:', u.id);
        console.log('Username:', u.username);
        console.log('Nombre:', u.nombre);
        console.log('Role_name:', u.role_name);
        console.log('Zona_id:', u.zona_id);
        console.log('Activo:', u.activo);
        console.log('Supervisor_id:', u.supervisor_id);
      });
    } else {
      console.log('[Script] User not found by name');
    }
    
    // Search by partial ID (in case the ID provided is incomplete)
    const usersById = await db('users')
      .where('id', 'like', '3d463ff5%')
      .select('*');
    
    if (usersById.length > 0) {
      console.log(`\n[Script] Found ${usersById.length} user(s) by partial ID:`);
      usersById.forEach(u => {
        console.log('---');
        console.log('ID:', u.id);
        console.log('Username:', u.username);
        console.log('Nombre:', u.nombre);
        console.log('Role_name:', u.role_name);
      });
    }
    
    // List all superadmin users
    const superadmins = await db('users')
      .where('role_name', 'superadmin')
      .select('id', 'username', 'nombre', 'role_name', 'activo');
    
    console.log(`\n[Script] Total superadmin users: ${superadmins.length}`);
    superadmins.forEach(u => {
      console.log('---');
      console.log('ID:', u.id);
      console.log('Username:', u.username);
      console.log('Nombre:', u.nombre);
      console.log('Role:', u.role_name);
      console.log('Activo:', u.activo);
    });
    
  } catch (error) {
    console.error('[Script] Error:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('[Script] Connection refused. Check DATABASE_URL or DB_HOST/DB_PORT.');
    } else if (error.message.includes('SSL')) {
      console.error('[Script] SSL error. The server may not support SSL connections.');
    }
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

verifyUser();
