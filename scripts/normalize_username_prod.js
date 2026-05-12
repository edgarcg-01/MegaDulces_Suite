/**
 * Script to normalize specific username in production
 * Usage: NODE_ENV=production node scripts/normalize_username_prod.js
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

async function normalizeUsername() {
  try {
    console.log('[Script] Connecting to production database...');
    
    // Get current user
    const user = await db('users')
      .where('id', '3d463ff5-4abd-43d2-b7a5-8590e9dd4805')
      .first();
    
    if (!user) {
      console.log('[Script] User not found');
      return;
    }
    
    console.log('[Script] Current username:', user.username);
    
    const normalizedUsername = user.username.toLowerCase().trim();
    
    if (user.username === normalizedUsername) {
      console.log('[Script] Username already normalized');
      return;
    }
    
    console.log('[Script] Normalizing to:', normalizedUsername);
    
    // Update username
    await db('users')
      .where('id', '3d463ff5-4abd-43d2-b7a5-8590e9dd4805')
      .update({ username: normalizedUsername });
    
    console.log('[Script] Username normalized successfully');
    
    // Verify
    const updated = await db('users')
      .where('id', '3d463ff5-4abd-43d2-b7a5-8590e9dd4805')
      .first();
    
    console.log('[Script] New username:', updated.username);
    
  } catch (error) {
    console.error('[Script] Error:', error.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

normalizeUsername();
