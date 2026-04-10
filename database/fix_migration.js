const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function addCloudinaryColumn() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'trade_marketing',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  try {
    await client.connect();
    console.log('Connected to database');

    // Check if column already exists
    const checkColumnQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'exhibition_photos' 
      AND column_name = 'photo_public_id'
    `;
    
    const result = await client.query(checkColumnQuery);
    
    if (result.rows.length === 0) {
      console.log('Adding photo_public_id column to exhibition_photos table...');
      
      // Add the column
      await client.query(`
        ALTER TABLE exhibition_photos 
        ADD COLUMN photo_public_id VARCHAR(255)
      `);
      
      console.log('Column added successfully');
      
      // Add index for better performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_exhibition_photos_public_id 
        ON exhibition_photos(photo_public_id)
      `);
      
      console.log('Index added successfully');
    } else {
      console.log('Column photo_public_id already exists in exhibition_photos table');
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
    console.log('Database connection closed');
  }
}

addCloudinaryColumn();
