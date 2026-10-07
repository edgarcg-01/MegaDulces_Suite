/**
 * Migration: Normalize usernames to lowercase
 * 
 * This migration normalizes all existing usernames to lowercase to ensure consistency
 * and prevent issues with case-sensitive username comparisons.
 * 
 * Problem: Some usernames were registered with different cases (e.g., "User_prueba" vs "user_prueba")
 * Solution: Normalize all usernames to lowercase and trim whitespace
 */

exports.up = async function(knex) {
  console.log('[Migration] Starting username normalization...');
  
  // Get all users with their current usernames
  const users = await knex('users').select('id', 'username');
  
  console.log(`[Migration] Found ${users.length} users to process`);
  
  let updatedCount = 0;
  let skippedCount = 0;
  
  for (const user of users) {
    const currentUsername = user.username;
    const normalizedUsername = currentUsername ? currentUsername.toLowerCase().trim() : currentUsername;
    
    // Only update if the username would change
    if (currentUsername !== normalizedUsername) {
      await knex('users')
        .where({ id: user.id })
        .update({ username: normalizedUsername });
      
      console.log(`[Migration] Updated user ${user.id}: "${currentUsername}" -> "${normalizedUsername}"`);
      updatedCount++;
    } else {
      skippedCount++;
    }
  }
  
  console.log(`[Migration] Completed: ${updatedCount} usernames updated, ${skippedCount} skipped`);
};

exports.down = async function(knex) {
  console.log('[Migration Rollback] Username normalization cannot be automatically rolled back.');
  console.log('[Migration Rollback] Please restore from backup if needed.');
};
