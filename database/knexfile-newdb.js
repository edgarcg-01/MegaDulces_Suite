"use strict";

// Cargar .env desde la raíz del proyecto (knex CLI cambia cwd a database/).
// Sin esto, las env vars no llegan al knexfile y la conexión falla con
// "authentication failed" porque pg toma defaults vacíos.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Knexfile para la NUEVA base de datos multi-tenant (`postgres_platform`).
 *
 * IMPORTANTE: este archivo es SEPARADO del knexfile principal (`knexfile.js`)
 * que sigue apuntando a la DB legacy. Mientras dure la transición:
 *
 *   - DB legacy: knexfile.js + database/migrations/ + database/seeds/
 *   - DB nueva:  knexfile-newdb.js + database/migrations-newdb/ + database/seeds-newdb/
 *
 * Cuando se haga el cutover (Sprint A.0mt.5), el knexfile principal pasa a
 * apuntar a esta DB y la legacy queda archivada.
 *
 * Comandos:
 *   npx knex migrate:latest --knexfile database/knexfile-newdb.js
 *   npx knex migrate:make <name> --knexfile database/knexfile-newdb.js
 *   npx knex seed:run --knexfile database/knexfile-newdb.js
 */

const config = {
  development: {
    client: 'pg',
    connection: process.env.DATABASE_URL_NEW
      ? { connectionString: process.env.DATABASE_URL_NEW }
      : {
          host: process.env.NEW_DB_HOST || '192.168.0.245',
          port: Number(process.env.NEW_DB_PORT) || 5432,
          database: process.env.NEW_DB_NAME || 'postgres_platform',
          user: process.env.NEW_DB_USER || 'postgres',
          password: process.env.NEW_DB_PASSWORD || 'postgres',
        },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: './migrations-newdb',
      tableName: 'knex_migrations',
      schemaName: 'public',
    },
    seeds: {
      directory: './seeds-newdb',
    },
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL_NEW
      ? { connectionString: process.env.DATABASE_URL_NEW, ssl: { rejectUnauthorized: false } }
      : {
          host: process.env.NEW_DB_HOST,
          port: Number(process.env.NEW_DB_PORT) || 5432,
          database: process.env.NEW_DB_NAME || 'postgres_platform',
          user: process.env.NEW_DB_USER,
          password: process.env.NEW_DB_PASSWORD,
          ssl: { rejectUnauthorized: false },
        },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: './migrations-newdb',
      tableName: 'knex_migrations',
      schemaName: 'public',
    },
    seeds: {
      directory: './seeds-newdb',
    },
  },
};

module.exports = config;
module.exports.connectionConfig = config;
