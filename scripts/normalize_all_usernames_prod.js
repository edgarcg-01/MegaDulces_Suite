/**
 * Script to normalize all usernames in production
 * Usage: NODE_ENV=production node scripts/normalize_all_usernames_prod.js
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

async function normalizeAllUsernames() {
  try {
    console.log('[Script] Connecting to production database...');
    
    const users = await db('users').select('id', 'username', 'nombre', 'role_name');
    
    console.log(`[Script] Total users: ${users.length}`);
    
    const nonNormalized = users.filter(u => u.username !== u.username.toLowerCase());
    
    if (nonNormalized.length === 0) {
      console.log('[Script] All usernames are already normalized');
      return;
    }
    
    console.log(`[Script] Found ${nonNormalized.length} user(s) with non-normalized usernames`);
    
    let updatedCount = 0;
    
    for (const user of nonNormalized) {
      const normalizedUsername = user.username.toLowerCase().trim();
      
      console.log(`[Script] Normalizing: "${user.username}" -> "${normalizedUsername}"`);
      
      await db('users')
        .where('id', user.id)
        .update({ username: normalizedUsername });
      
      updatedCount++;
    }
    
    console.log(`[Script] Completed: ${updatedCount} usernames normalized`);
    
  } catch (error) {
    console.error('[Script] Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

normalizeAllUsernames();
