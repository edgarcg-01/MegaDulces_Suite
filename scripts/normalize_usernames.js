/**
 * Script to normalize usernames to lowercase
 * Run this script directly: node scripts/normalize_usernames.js
 */

const knex = require('knex');
const knexfile = require('../database/knexfile.js');

const environment = process.env.NODE_ENV || 'development';
const config = knexfile[environment];

const db = knex(config);

async function normalizeUsernames() {
  try {
    console.log('[Script] Starting username normalization...');
    
    // Get all users with their current usernames
    const users = await db('users').select('id', 'username');
    
    console.log(`[Script] Found ${users.length} users to process`);
    
    let updatedCount = 0;
    let skippedCount = 0;
    
    for (const user of users) {
      const currentUsername = user.username;
      const normalizedUsername = currentUsername ? currentUsername.toLowerCase().trim() : currentUsername;
      
      // Only update if the username would change
      if (currentUsername !== normalizedUsername) {
        await db('users')
          .where({ id: user.id })
          .update({ username: normalizedUsername });
        
        console.log(`[Script] Updated user ${user.id}: "${currentUsername}" -> "${normalizedUsername}"`);
        updatedCount++;
      } else {
        skippedCount++;
      }
    }
    
    console.log(`[Script] Completed: ${updatedCount} usernames updated, ${skippedCount} skipped`);
  } catch (error) {
    console.error('[Script] Error:', error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

normalizeUsernames();
