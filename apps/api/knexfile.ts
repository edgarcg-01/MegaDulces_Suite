import type { Knex } from 'knex';
import { join } from 'path';

const config: Knex.Config = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // SSL va exclusivamente aquí adentro de connection
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
  },
  migrations: {
    tableName: 'knex_migrations',
    directory:
      process.env.NODE_ENV === 'production'
        // process.cwd() apunta a /app en Docker, y de ahí bajamos a dist/...
        ? join(process.cwd(), 'dist', 'apps', 'api', 'shared', 'database', 'migrations')
        : './apps/api/src/shared/database/migrations',
  },
  seeds: {
    directory:
      process.env.NODE_ENV === 'production'
        ? join(process.cwd(), 'dist', 'apps', 'api', 'shared', 'database', 'seeds')
        : './apps/api/src/shared/database/seeds',
  },
};

export default config;