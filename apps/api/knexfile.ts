import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    // SSL es requerido por Render para conexiones de base de datos
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
  },
  migrations: {
    tableName: 'knex_migrations',
    // En producción (Docker), las migraciones se copian a dist/apps/api/shared/database/migrations
    directory:
      process.env.NODE_ENV === 'production'
        ? './shared/database/migrations'
        : './apps/api/src/shared/database/migrations',
  },
  seeds: {
    directory:
      process.env.NODE_ENV === 'production'
        ? './shared/database/seeds'
        : './apps/api/src/shared/database/seeds',
  },
};

export default config;
