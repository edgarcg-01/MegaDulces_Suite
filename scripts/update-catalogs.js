
const knex = require('knex');
const dotenv = require('dotenv');

dotenv.config();

const db = knex({
  client: 'postgresql',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'trade_marketing',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'admin',
  }
});

async function run() {
  try {
    console.log('--- Iniciando actualización de Catálogos (Iconos Minimalistas) ---');
    
    // Limpiamos solo los conceptos para no alterar otros datos si existen
    await db('catalogs').where({ catalog_id: 'conceptos' }).del();

    await db('catalogs').insert([
      { catalog_id: "roles", value: "superadmin", orden: 1 },
      { catalog_id: "roles", value: "admin", orden: 2 },
      { catalog_id: "roles", value: "supervisor", orden: 3 },
      { catalog_id: "roles", value: "auditor", orden: 4 },
    ]);

    console.log('--- Sincronización de Catálogos (Configuración v5) completada ---');

    console.log('--- Actualización de Iconos completada con éxito ---');
  } catch (error) {
    console.error('--- ERROR DURANTE LA ACTUALIZACIÓN ---');
    console.error(error);
  } finally {
    await db.destroy();
  }
}

run();
