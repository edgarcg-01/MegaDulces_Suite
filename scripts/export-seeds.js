const knex = require('knex');
const path = require('path');
const fs = require('fs');
const config = require('../database/knexfile.js');

const db = knex(config.development);
const SEEDS_DIR = path.join(__dirname, '../database/seeds');

// Dependency order (Parents first for insertion, but script will generate separate files)
// For "delete before insert", we need to be careful.
// A simpler way is to have ONE seed file that handles everything OR
// prefix them so they run in order.

const TABLE_MAPPING = {
  'role_permissions': '00_roles.js',
  'users': '01_users.js',
  'brands': '02_brands.js',
  'products': '03_products.js',
  'catalogs': '04_catalogs.js',
  'scoring_config': '05_scoring_config.json', // Wait, existing is 05_scoring_config.js
  'scoring_config': '05_scoring_config.js',
  'daily_assignments': '07_daily_assignments.js',
  'daily_captures': '08_daily_captures.js',
  'stores': '09_stores.js',
  'visits': '10_visits.js',
  'captures': '11_captures.js',
  'exhibitions': '12_exhibitions.js',
  'exhibition_photos': '13_exhibition_photos.js'
};

async function exportTable(table) {
  console.log(`Exporting table: ${table}...`);
  const data = await db(table).select('*');
  
  if (data.length === 0) {
    console.log(`Table ${table} is empty, skipping.`);
    return;
  }

  const fileName = TABLE_MAPPING[table] || `seed_${table}.js`;
  const filePath = path.join(SEEDS_DIR, fileName);

  const content = `/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Deletes ALL existing entries
  await knex("${table}").del();

  // Inserts seed entries
  await knex("${table}").insert(${JSON.stringify(data, null, 2)});
};
`;

  fs.writeFileSync(filePath, content);
  console.log(`Saved ${filePath}`);
}

async function run() {
  try {
    const tablesResult = await db.raw("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
    const tables = tablesResult.rows.map(r => r.tablename).filter(t => !t.startsWith('knex_'));
    
    // Create seeds dir if not exists
    if (!fs.existsSync(SEEDS_DIR)) {
      fs.mkdirSync(SEEDS_DIR, { recursive: true });
    }

    for (const table of tables) {
      await exportTable(table);
    }
    
    console.log('Export finished successfully.');
  } catch (err) {
    console.error('Error during export:', err);
  } finally {
    await db.destroy();
  }
}

run();
