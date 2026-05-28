import { AsyncLocalStorage } from 'async_hooks';
import { Knex } from 'knex';

/**
 * Singleton ALS para propagar el trx legacy a través de todo el request.
 *
 * Setup: en cada request HTTP con JWT válido (tenant_id presente), el
 * TenantContextInterceptor abre un trx contra el KNEX_CONNECTION_RAW, hace
 * `SET LOCAL app.tenant_id = ...` y guarda el trx aquí.
 *
 * Uso: el Proxy de KNEX_CONNECTION lee este storage en cada call/property
 * access. Si hay un store → reenvía al trx (que ya tiene la GUC seteada).
 * Si no hay → usa el knex raw (sin tenant scope — endpoints públicos o sin
 * auth como /api/auth/login).
 *
 * Sin DI para evitar ciclos: DatabaseModule no puede depender de TenantModule
 * (TenantModule importa muchas cosas y se carga condicionalmente).
 */
export interface LegacyTxStore {
  tx: Knex.Transaction;
  tenantId: string;
}

export const legacyTxStorage = new AsyncLocalStorage<LegacyTxStore>();
