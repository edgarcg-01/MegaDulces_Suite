'use strict';

// Cargar .env desde la raíz (knex CLI cambia cwd a database/).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

/**
 * Knexfile de la base de ASISTENCIA (Fase CH) — `hr` en 192.168.0.245.
 *
 * Base DEDICADA y on-prem, separada de `postgres_platform`:
 *   - los checadores son equipos de LAN; la ingesta no debe depender de Railway
 *   - los datos de personal tienen ciclo de vida y acceso propios
 *
 * Costo de la separación (asumido a propósito): no hay join con
 * `commercial.warehouses` (crosswalk de sucursal) ni con `public.users`
 * (auditoría). El puente se hace por `site_code` / `employee_code` como
 * códigos de texto, no por FK.
 *
 * Las tablas viven en el schema `hr` (no en `public`) para que el SQL sea
 * idéntico al de `postgres_platform.hr.*` y el código sea portable entre las
 * dos bases cambiando solo la cadena de conexión.
 *
 * Comandos:
 *   npx knex migrate:latest --knexfile database/knexfile-hr.js
 *   npx knex migrate:make <nombre> --knexfile database/knexfile-hr.js
 */

const connection = () => (process.env.DATABASE_URL_HR
  ? { connectionString: process.env.DATABASE_URL_HR }
  : {
      host: process.env.HR_DB_HOST || '192.168.0.245',
      port: Number(process.env.HR_DB_PORT) || 5432,
      database: process.env.HR_DB_NAME || 'hr',
      user: process.env.HR_DB_USER,
      password: process.env.HR_DB_PASSWORD,
    });

const config = {
  development: {
    client: 'pg',
    connection: connection(),
    pool: { min: 1, max: 8 },
    migrations: { directory: './migrations-hr', tableName: 'knex_migrations', schemaName: 'public' },
  },
  production: {
    client: 'pg',
    connection: connection(),
    pool: { min: 1, max: 8 },
    migrations: { directory: './migrations-hr', tableName: 'knex_migrations', schemaName: 'public' },
  },
};

module.exports = config;
module.exports.connectionConfig = config;
