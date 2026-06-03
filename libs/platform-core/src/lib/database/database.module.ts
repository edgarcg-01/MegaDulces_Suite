import { Global, Module, Logger } from '@nestjs/common';
import knex, { Knex } from 'knex';
import { legacyTxStorage } from '../tenant/legacy-tx.als';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';
export const KNEX_CONNECTION_RAW = 'KNEX_CONNECTION_RAW';

/**
 * Conexión a la DB **legacy** (post-cutover: misma physical DB que
 * NewDatabaseModule, accedida con user `postgres` que bypassea RLS).
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

/**
 * Crea un Proxy callable sobre `raw` que enruta cada operación al trx en CLS
 * si hay uno (request multi-tenant), o al raw si no (endpoints públicos).
 *
 * Knex la instancia es callable (knex('table')) Y tiene properties (knex.raw,
 * knex.fn, knex.transaction). El Proxy debe manejar ambos casos.
 */
function createTenantAwareKnexProxy(raw: Knex): Knex {
  const handler: ProxyHandler<Knex> = {
    apply(_target, _thisArg, args) {
      const store = legacyTxStorage.getStore();
      const target = (store?.tx ?? raw) as any;
      return target(...args);
    },
    get(_target, prop, _receiver) {
      const store = legacyTxStorage.getStore();
      const target = (store?.tx ?? raw) as any;
      const value = target[prop];
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  };
  return new Proxy(raw, handler);
}

@Global()
@Module({
  providers: [
    {
      provide: KNEX_CONNECTION_RAW,
      useFactory: () => knex(buildLegacyDbConfig()),
    },
    {
      provide: KNEX_CONNECTION,
      useFactory: (raw: Knex) => createTenantAwareKnexProxy(raw),
      inject: [KNEX_CONNECTION_RAW],
    },
  ],
  exports: [KNEX_CONNECTION, KNEX_CONNECTION_RAW],
})
export class DatabaseModule {}
