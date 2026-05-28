import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import knex, { Knex } from 'knex';
import { TenantModule } from '../tenant/tenant.module';
import { TenantContextService } from '../tenant/tenant-context.service';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';
export const KNEX_CONNECTION_RAW = 'KNEX_CONNECTION_RAW';

/**
 * Build de la config Knex legacy. DENTRO de useFactory para que process.env
 * se evalúe DESPUÉS de dotenv.config() en main.ts (webpack hoistea imports).
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
      'Ni DATABASE_URL ni DB_NAME seteados — el módulo legacy fallará al conectar. ' +
        'Si solo usás multi-tenant (auth-mt), esto puede ser benigno hasta que se elimine el AuthModule legacy.',
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
 * Proxy del Knex legacy que routea queries a la transacción del CLS si existe.
 *
 * Cuando hay `legacyTx` en el TenantContext (lo abre el TenantContextInterceptor
 * al inicio de cada request con `SET LOCAL app.tenant_id`), todas las queries
 * de los services legacy (this.knex('stores').insert, etc.) se ejecutan
 * DENTRO de esa transacción. El trigger `auto_populate_tenant_id` pobla
 * automáticamente `tenant_id` desde `current_tenant_id()`.
 *
 * Cuando NO hay tx (request sin auth, cron job), el proxy delega al pool
 * normal. El trigger DB rechaza INSERTs sin tenant_id con error explícito.
 *
 * Si `tenantCtx` es null (modo single-tenant puro), el proxy se desactiva
 * y devuelve el Knex raw — comportamiento legacy intacto.
 */
function buildKnexProxy(baseKnex: Knex, tenantCtx: TenantContextService | null): Knex {
  if (!tenantCtx) {
    new Logger('DatabaseModule').warn(
      'TenantContextService NO inyectado en buildKnexProxy — los INSERTs de tablas con tenant_id NOT NULL van a fallar. ' +
      'Verificar que TenantModule esté importado y ENABLE_MULTITENANT=true.',
    );
    return baseKnex;
  }
  new Logger('DatabaseModule').log('Knex proxy multi-tenant ACTIVO (routea a legacyTx del CLS).');

  return new Proxy(baseKnex, {
    apply(target, thisArg, args) {
      const tx = tenantCtx.get()?.legacyTx;
      if (tx) return Reflect.apply(tx as any, undefined, args);
      return Reflect.apply(target as any, thisArg, args);
    },
    get(target, prop, receiver) {
      const tx = tenantCtx.get()?.legacyTx;
      if (tx) {
        const value = Reflect.get(tx as any, prop, tx);
        return typeof value === 'function' ? value.bind(tx) : value;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * DatabaseModule legacy (single-tenant) con soporte opcional multi-tenant.
 *
 * - `forRoot()` (default): modo legacy puro. KNEX_CONNECTION es Knex base sin proxy.
 *   Para apps single-tenant clásicas.
 *
 * - `forRoot({ multitenant: true })`: importa TenantModule, KNEX_CONNECTION es
 *   un Proxy que routea queries a la legacyTx del CLS (con SET LOCAL
 *   app.tenant_id seteado por TenantContextInterceptor). Garantiza:
 *     · INSERTs auto-popularán tenant_id via trigger DB
 *     · Cero refactor en services legacy (siguen usando `this.knex` como
 *       siempre)
 *     · Defensa en profundidad (proxy + trigger DB)
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(opts: { multitenant?: boolean } = {}): DynamicModule {
    const multitenant = opts.multitenant ?? process.env.ENABLE_MULTITENANT === 'true';

    return {
      module: DatabaseModule,
      global: true,
      // Cuando multitenant=true, importamos TenantModule EXPLÍCITAMENTE.
      // Esto garantiza que TenantContextService esté disponible cuando Nest
      // resuelva el useFactory de KNEX_CONNECTION (antes el `optional: true`
      // hacía que Nest no esperara → tenantCtx llegaba null → proxy inactivo).
      imports: multitenant ? [TenantModule] : [],
      providers: [
        {
          provide: KNEX_CONNECTION_RAW,
          useFactory: () => knex(buildLegacyDbConfig()),
        },
        {
          provide: KNEX_CONNECTION,
          inject: multitenant
            ? [KNEX_CONNECTION_RAW, TenantContextService]
            : [KNEX_CONNECTION_RAW],
          useFactory: (rawKnex: Knex, tenantCtx?: TenantContextService) =>
            buildKnexProxy(rawKnex, tenantCtx ?? null),
        },
      ],
      exports: [KNEX_CONNECTION, KNEX_CONNECTION_RAW],
    };
  }
}
