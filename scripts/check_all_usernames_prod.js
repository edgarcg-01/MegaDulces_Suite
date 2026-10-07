/**
 * Script to check all usernames in production for normalization
 * Usage: NODE_ENV=production node scripts/check_all_usernames_prod.js
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

async function checkAllUsernames() {
  try {
    console.log('[Script] Connecting to production database...');
    
    const users = await db('users').select('id', 'username', 'nombre', 'role_name');
    
    console.log(`[Script] Total users: ${users.length}`);
    
    const nonNormalized = users.filter(u => u.username !== u.username.toLowerCase());
    
    if (nonNormalized.length > 0) {
      console.log(`[Script] Found ${nonNormalized.length} user(s) with non-normalized usernames:`);
      nonNormalized.forEach(u => {
        console.log('---');
        console.log('ID:', u.id);
        console.log('Username:', u.username);
        console.log('Normalized:', u.username.toLowerCase());
        console.log('Nombre:', u.nombre);
        console.log('Role:', u.role_name);
      });
    } else {
      console.log('[Script] All usernames are normalized');
    }
    
  } catch (error) {
    console.error('[Script] Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

checkAllUsernames();
