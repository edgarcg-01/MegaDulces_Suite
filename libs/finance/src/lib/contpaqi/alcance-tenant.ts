import { AsyncLocalStorage } from 'node:async_hooks';
import type { Knex } from 'knex';

/**
 * ⛔⛔ `[CP.8.58]` — **El tenant lo fija el servicio, no el rol.**
 *
 * Las tablas del puente (`finance.bank_*`, `finance.movement_categories`, `contpaqi.*`) tienen RLS
 * forzado con `tenant_id = current_tenant_id()`. La API corre como `app_runtime`, que **no** trae
 * `app.tenant_id` por default; los roles personales (`edgar`, `david`…) **sí**
 * (`pg_db_role_setting`). Por eso todo lo medido y probado como `edgar` vio datos, y la API habría
 * visto **cero filas, sin error**.
 *
 * Un servicio que inyecta `KNEX_NEW_DB` pelado guarda el pool y expone `db` desde acá:
 *
 *     private readonly alcance = new AlcanceTenant();
 *     private get db(): Knex { return this.alcance.db; }
 *     async metodo() { return this.alcance.run(this.pool, MEGA, () => …this.db…); }
 *
 * ⭐ `db` **lanza** fuera de `run()` en vez de caer al pool: un acceso olvidado se ve en el primer
 * candado y no como una bandeja vacía en prod. `run()` es reentrante: un método público que llama
 * a otro comparte la misma transacción.
 *
 * ⚠️ Es la versión para servicios sin request (`@Cron`) o con el tenant fijo. Con request,
 * `TenantKnexService.run()` lee el tenant del contexto. Si aparece un tercer consumidor, esto va a
 * `libs/platform-core` (deuda con nombre en el tracker, `[CP.8.58]`).
 *
 * ⚠️ No usa `runWithTenant` de `platform-core` a propósito: importar ese barrel arrastra subrutas
 * (`@megadulces/contracts/authz/…`) que los candados por `ts-node` no resuelven. Fija el tenant
 * con `set_config(…, true)` parametrizado, igual que `login-core.ts` — mismo efecto que su
 * `SET LOCAL`: vale sólo dentro de la transacción y no se filtra a la conexión del pool.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AlcanceTenant {
  private readonly als = new AsyncLocalStorage<Knex.Transaction>();

  get db(): Knex {
    const trx = this.als.getStore();
    if (!trx) throw new Error('[CP.8.58] acceso a tablas con RLS fuera de AlcanceTenant.run(): devolvería cero filas');
    return trx;
  }

  run<T>(pool: Knex, tenantId: string, fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();
    if (!UUID.test(tenantId)) throw new Error(`[CP.8.58] tenant inválido: "${tenantId}"`);
    return pool.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
      return this.als.run(trx, fn);
    });
  }
}
