import { Global, Module, Logger } from '@nestjs/common';
import knex, { Knex } from 'knex';
import * as path from 'path';

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
 * Carga config de la nueva DB desde env vars. Prefiere `DATABASE_URL_NEW`
 * (connection string completo) sobre las variables sueltas.
 */
function buildNewDbConfig(): Knex.Config {
  if (process.env.DATABASE_URL_NEW) {
    return {
      client: 'pg',
      connection: {
        connectionString: process.env.DATABASE_URL_NEW,
        // SSL solo en prod (Railway requiere, local no).
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

  return {
    client: 'pg',
    connection: {
      host: process.env.NEW_DB_HOST || '192.168.0.245',
      port: Number(process.env.NEW_DB_PORT) || 5432,
      database: process.env.NEW_DB_NAME || 'postgres_platform',
      user: process.env.NEW_DB_USER || 'postgres',
      password: process.env.NEW_DB_PASSWORD || '',
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
        const target = process.env.DATABASE_URL_NEW
          ? '<from DATABASE_URL_NEW>'
          : `${process.env.NEW_DB_HOST || '192.168.0.245'}:${process.env.NEW_DB_PORT || 5432}/${process.env.NEW_DB_NAME || 'postgres_platform'}`;
        logger.log(`Connecting to new multi-tenant DB at ${target}`);
        return knex(config);
      },
    },
  ],
  exports: [KNEX_NEW_DB],
})
export class NewDatabaseModule {}
