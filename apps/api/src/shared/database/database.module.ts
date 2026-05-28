import { Global, Module, Logger } from '@nestjs/common';
import knex, { Knex } from 'knex';
import { TenantContextService } from '../tenant/tenant-context.service';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';
export const KNEX_CONNECTION_RAW = 'KNEX_CONNECTION_RAW';

/**
 * Conexión a la DB **legacy** (puede coexistir con la nueva multi-tenant via
 * NewDatabaseModule + ENABLE_MULTITENANT toggle).
 *
 * IMPORTANTE: la config se construye DENTRO de useFactory para que `process.env`
 * se evalúe DESPUÉS de `dotenv.config()` en main.ts. Webpack hoistea imports,
 * así que si el config se importara como objeto estático (como antes via
 * knexfile.ts), `process.env.DATABASE_URL` sería `undefined` en module-load
 * time y caería al fallback `megadulces_logistica`. Bug vivido 2026-05-26.
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
 * Cuando `ENABLE_MULTITENANT=true`, el `TenantContextInterceptor` abre una
 * transacción del pool legacy al inicio del request, ejecuta
 * `SET LOCAL app.tenant_id = '...'`, y la guarda en `tenantCtx.legacyTx`.
 *
 * Los services legacy hacen `this.knex('stores').insert(...)` como siempre,
 * pero al pasar por este proxy:
 *   - Si hay `legacyTx` en el CLS → la query se ejecuta DENTRO de esa tx, con
 *     `app.tenant_id` seteado → el trigger `auto_populate_tenant_id` poblará
 *     `tenant_id` automáticamente.
 *   - Si NO hay `legacyTx` (request sin auth, cron job, boot) → la query usa
 *     el pool normal sin tenant context. Si toca una tabla con `tenant_id NOT
 *     NULL`, el trigger lanzará excepción explícita ("tenant_id no provisto").
 *
 * Esto es TRANSPARENTE para todos los services legacy — no requiere modificar
 * ni un solo `stores.service.ts`, `visits.service.ts`, etc. La defensa en
 * profundidad es el trigger DB (migración `20260527180000_auto_populate_tenant_id_trigger`).
 *
 * Cuando `ENABLE_MULTITENANT=false`, el TenantContextService no está
 * disponible y el proxy devuelve el Knex base sin wrapping.
 */
function buildKnexProxy(baseKnex: Knex, tenantCtx: TenantContextService | null): Knex {
  if (!tenantCtx) return baseKnex; // legacy mode puro, sin multi-tenant

  // Knex es una función (knex('tabla')) y también un objeto (knex.raw, knex.schema, knex.transaction, etc).
  // El proxy debe cubrir AMBOS casos.
  return new Proxy(baseKnex, {
    apply(target, thisArg, args) {
      // Caso: knex('tableName') — invocación como función
      const tx = tenantCtx.get()?.legacyTx;
      if (tx) return Reflect.apply(tx as any, undefined, args);
      return Reflect.apply(target as any, thisArg, args);
    },
    get(target, prop, receiver) {
      // Caso: knex.raw, knex.schema, knex.transaction, knex.fn, etc.
      const tx = tenantCtx.get()?.legacyTx;
      if (tx) {
        const value = Reflect.get(tx as any, prop, tx);
        // Bindear métodos al tx para preservar `this`
        return typeof value === 'function' ? value.bind(tx) : value;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

@Global()
@Module({
  providers: [
    // El raw expone el pool real (sin proxy). Lo usa el TenantContextInterceptor
    // para abrir transacciones manuales del pool legacy.
    {
      provide: KNEX_CONNECTION_RAW,
      useFactory: () => knex(buildLegacyDbConfig()),
    },
    // El que inyectan los services es el PROXY. Transparente: igual interfaz que Knex.
    // Routea a la tx del CLS (con SET LOCAL app.tenant_id) si hay request en curso.
    {
      provide: KNEX_CONNECTION,
      inject: [
        KNEX_CONNECTION_RAW,
        // TenantContextService es @Global cuando ENABLE_MULTITENANT=true.
        // Sin él (legacy single-tenant), inject devuelve undefined y el proxy
        // se desactiva (devuelve el Knex base).
        { token: TenantContextService, optional: true },
      ],
      useFactory: (rawKnex: Knex, tenantCtx: TenantContextService | null) =>
        buildKnexProxy(rawKnex, tenantCtx),
    },
  ],
  exports: [KNEX_CONNECTION, KNEX_CONNECTION_RAW],
})
export class DatabaseModule {}
