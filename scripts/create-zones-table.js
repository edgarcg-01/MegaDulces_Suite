/**
 * Script rápido para crear tabla zones y poblar datos
 * Usa conexión directa a PostgreSQL sin sistema de migraciones
 */

const { Pool } = require('pg');
require('dotenv').config();

async function createZonesTable() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'trade_marketing',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  try {
    console.log('Conectando a la base de datos...');
    const client = await pool.connect();
    
    // Verificar si la tabla existe
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'zones'
      );
    `);
    
    if (checkTable.rows[0].exists) {
      console.log('✅ La tabla zones ya existe');
      
      // Verificar si tiene datos
      const count = await client.query('SELECT COUNT(*) FROM zones');
      console.log(`   Zonas existentes: ${count.rows[0].count}`);
      
      client.release();
      await pool.end();
      return;
    }
    
    console.log('Creando tabla zones...');
    
    // Crear tabla zones
    await client.query(`
      CREATE TABLE zones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL UNIQUE,
        orden INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('✅ Tabla zones creada');
    
    // Insertar zonas por defecto
    const defaultZones = [
      { id: 'fb136f01-5efe-4c9f-b297-48f06574002c', name: 'LA PIEDAD', orden: 1 },
      { id: 'b3e5d1cf-bf7e-419f-9037-b02f070bd2bc', name: 'ZAMORA', orden: 2 },
      { id: '2107b482-7d3a-4c82-9377-c9f2427e699e', name: 'MORELIA', orden: 3 },
      { id: 'a5f9532e-a836-455c-9c8c-3df906615a5b', name: 'NACIONAL', orden: 4 },
      { id: 'f63125c2-025f-4122-89f0-14f3c80ac0ca', name: 'CANINDO', orden: 5 },
    ];
    
    for (const zone of defaultZones) {
      await client.query(
        'INSERT INTO zones (id, name, orden) VALUES ($1, $2, $3)',
        [zone.id, zone.name, zone.orden]
      );
    }
    
    console.log('✅ Zonas por defecto insertadas:', defaultZones.length);
    
    // Verificar si existe columna zona_id en users
    const checkColumn = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'zona_id'
      );
    `);
    
    if (!checkColumn.rows[0].exists) {
      await client.query(`
        ALTER TABLE users 
        ADD COLUMN zona_id UUID REFERENCES zones(id);
      `);
      console.log('✅ Columna zona_id agregada a users');
    }
    
    console.log('\n✅ Todo listo. La tabla zones está configurada.');
    
    client.release();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Detalle:', error.detail);
  } finally {
    await pool.end();
  }
}

createZonesTable();
