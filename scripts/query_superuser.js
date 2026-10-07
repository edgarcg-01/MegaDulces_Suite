/**
 * Script to query superuser in production
 * Usage: NODE_ENV=production node scripts/query_superuser.js
 */

const knex = require('knex');

require('dotenv').config();

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
        ssl: false,
      },
  pool: { min: 2, max: 10 },
};

const db = knex(config);

async function querySuperuser() {
  try {
    console.log('[Script] Connecting to production database...');
    
    const user = await db('users')
      .where('username', 'superuser')
      .first();
    
    if (user) {
      console.log('[Script] Usuario encontrado:');
      console.log('---');
      console.log('ID:', user.id);
      console.log('Username:', user.username);
      console.log('Nombre:', user.nombre);
      console.log('Role_name:', user.role_name);
      console.log('Zona_id:', user.zona_id);
      console.log('Activo:', user.activo);
      console.log('Supervisor_id:', user.supervisor_id);
      console.log('Created_at:', user.created_at);
      
      // Get zone name
      if (user.zona_id) {
        const zone = await db('zones').where('id', user.zona_id).first();
        console.log('Zona_name:', zone ? zone.name : 'N/A');
      }
    } else {
      console.log('[Script] Usuario no encontrado');
    }
    
  } catch (error) {
    console.error('[Script] Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

querySuperuser();
