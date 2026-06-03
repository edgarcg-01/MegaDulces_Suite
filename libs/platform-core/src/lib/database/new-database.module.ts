import { Global, Module, Logger } from '@nestjs/common';
import knex, { Knex } from 'knex';
import * as path from 'path';
import { TenantKnexService } from './tenant-knex.service';

/**
 * Módulo que provee conexión a la **nueva DB multi-tenant** (`postgres_platform`).
 *
 * IMPORTANTE: Convive con `DatabaseModule` (DB legacy) durante la transición.
 * Hasta el cutover (Sprint A.0mt.5):
 *   - DatabaseModule → DB legacy (DATABASE_URL) → toda la app actual
 *   - NewDatabaseModule → nueva DB (DATABASE_URL_NEW) → código en migración
 *
 * Cuando se completa el cutover, este módulo reemplaza a DatabaseModule y
 * el legacy queda archivado.
 *
 * Token de inyección: `KNEX_NEW_DB`.
 */

export const KNEX_NEW_DB = 'KNEX_NEW_DB';

/**
 * Token de inyección para una conexión separada con el rol `postgres`
 * (superuser). Usado SOLO por operaciones admin que requieren bypass de RLS o
 * privilegios que app_runtime no tiene:
 *   - REFRESH MATERIALIZED VIEW (owner-only en Postgres)
 *   - Operaciones de mantenimiento (VACUUM, ANALYZE, etc.)
 *
 * NUNCA usar este token desde endpoints públicos — solo desde cron jobs y
 * servicios de admin. Si crece el surface area, agregar un guard que
 * restrinja el acceso por role_name.
 */
export const KNEX_NEW_DB_ADMIN = 'KNEX_NEW_DB_ADMIN';

/**
 * Carga config de la nueva DB desde env vars.
 *
 * CRÍTICO: usa `DATABASE_URL_NEW_RUNTIME` (rol `app_runtime`) — NO
 * `DATABASE_URL_NEW` (rol `postgres` superuser). El runtime debe correr con
 * un usuario que NO bypasee RLS, de lo contrario cualquier bug en el código
 * expondría data cross-tenant.
 *
 * Las MIGRACIONES sí usan `DATABASE_URL_NEW` (postgres) — knexfile-newdb.js
 * lee de ahí. Esta separación es intencional.
 */
function buildNewDbConfig(): Knex.Config {
  const connStr = process.env.DATABASE_URL_NEW_RUNTIME;
  if (connStr) {
    return {
      client: 'pg',
      connection: {
        connectionString: connStr,
        ssl:
          process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
      },
      pool: { min: 2, max: 10 },
      migrations: {
        directory: path.resolve(__dirname, '../../../../../database/migrations-newdb'),
        tableName: 'knex_migrations',
      },
    };
  }

  // Fallback con variables sueltas — usa user `app_runtime` (no postgres) en runtime
  return {
    client: 'pg',
    connection: {
      host: process.env.NEW_DB_HOST || '192.168.0.245',
      port: Number(process.env.NEW_DB_PORT) || 5432,
      database: process.env.NEW_DB_NAME || 'postgres_platform',
      user: 'app_runtime',
      password: process.env.APP_RUNTIME_PASSWORD || 'app_runtime',
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
    },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: path.resolve(__dirname, '../../../../../database/migrations-newdb'),
      tableName: 'knex_migrations',
    },
  };
}

@Global()
@Module({
  providers: [
    {
      provide: KNEX_NEW_DB,
      useFactory: () => {
        const logger = new Logger('NewDatabaseModule');
        const config = buildNewDbConfig();
        const target = process.env.DATABASE_URL_NEW_RUNTIME
          ? '<from DATABASE_URL_NEW_RUNTIME>'
          : `${process.env.NEW_DB_HOST || '192.168.0.245'}:${process.env.NEW_DB_PORT || 5432}/${process.env.NEW_DB_NAME || 'postgres_platform'} (fallback)`;
        logger.log(`Connecting to new multi-tenant DB at ${target}`);
        if (!process.env.DATABASE_URL_NEW_RUNTIME && process.env.NODE_ENV === 'production') {
          logger.error(
            'DATABASE_URL_NEW_RUNTIME no seteado en production — multi-tenant endpoints fallarán. Setear esta env var apuntando al rol app_runtime de la new DB Railway.',
          );
        }
        return knex(config);
      },
    },
    {
      provide: KNEX_NEW_DB_ADMIN,
      useFactory: () => {
        const logger = new Logger('NewDatabaseModule:Admin');
        const connStr = process.env.DATABASE_URL_NEW;
        if (!connStr) {
          logger.warn(
            'DATABASE_URL_NEW no seteado — KNEX_NEW_DB_ADMIN no podrá hacer REFRESH MV. Setear var para activar cron analytics.',
          );
          // Devolvemos null en runtime → consumers chequean antes de usar.
          return null;
        }
        logger.log('Admin (postgres) Knex connection lista para mantenimiento');
        return knex({
          client: 'pg',
          connection: {
            connectionString: connStr,
            ssl:
              process.env.NODE_ENV === 'production'
                ? { rejectUnauthorized: false }
                : false,
          },
          pool: { min: 0, max: 2 }, // pool chico — solo para cron/admin
        });
      },
    },
    TenantKnexService,
  ],
  exports: [KNEX_NEW_DB, KNEX_NEW_DB_ADMIN, TenantKnexService],
})
export class NewDatabaseModule {}
