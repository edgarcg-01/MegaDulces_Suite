import { Global, Module, Logger } from '@nestjs/common';
import knex from 'knex';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';

/**
 * Conexión a la DB **legacy** (puede coexistir con la nueva multi-tenant via
 * NewDatabaseModule + ENABLE_MULTITENANT toggle).
 *
 * IMPORTANTE: la config se construye DENTRO de useFactory para que `process.env`
 * se evalúe DESPUÉS de `dotenv.config()` en main.ts.
 */
function buildLegacyDbConfig(): any {
  const logger = new Logger('DatabaseModule');
  const env = process.env.NODE_ENV || 'development';
  const connStr = process.env.DATABASE_URL;
  if (connStr) {
    logger.log(`Connecting to legacy DB via DATABASE_URL (env=${env})`);
    return {
      client: 'pg',
      connection: {
        connectionString: connStr,
        ssl: env === 'production' ? { rejectUnauthorized: false } : false,
      },
      pool: { min: 2, max: 10 },
    };
  }
  const host = process.env.DB_HOST || 'localhost';
  const port = Number(process.env.DB_PORT) || 5432;
  const database = process.env.DB_NAME;
  if (!database) {
    logger.warn(
      'Ni DATABASE_URL ni DB_NAME seteados — el módulo legacy fallará al conectar.',
    );
  }
  return {
    client: 'pg',
    connection: {
      host,
      port,
      database: database || 'megadulces_logistica',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      ssl: env === 'production' ? { rejectUnauthorized: false } : false,
    },
    pool: { min: 2, max: 10 },
  };
}

@Global()
@Module({
  providers: [
    {
      provide: KNEX_CONNECTION,
      useFactory: () => knex(buildLegacyDbConfig()),
    },
  ],
  exports: [KNEX_CONNECTION],
})
export class DatabaseModule {}
