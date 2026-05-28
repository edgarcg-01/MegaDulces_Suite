import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * Token string para evitar circular import con new-database.module.ts.
 * Debe coincidir con el `provide:` que registra el provider del Knex.
 */
const KNEX_NEW_DB_TOKEN = 'KNEX_NEW_DB';

/**
 * Helpers para correr queries con tenant context aislado.
 *
 * Patrón:
 *   - Postgres soporta `SET LOCAL` para variables de sesión que se resetean
 *     al COMMIT/ROLLBACK. Usamos eso para setear `app.tenant_id` dentro de
 *     UNA transacción específica.
 *   - `SET LOCAL` SOLO funciona dentro de transacciones — sin BEGIN, no aplica.
 *   - El valor seteado es leído por `current_tenant_id()` (función creada en
 *     la migración inicial) y por las políticas RLS que vendrán en migraciones
 *     futuras (Sprint A.0mt.2).
 *
 * ¿Por qué `SET LOCAL` y no `SET` (sin LOCAL)?
 *   - `SET` persiste a nivel CONNECTION, no a nivel transacción.
 *   - Como Knex usa pool de conexiones, otra request podría obtener la misma
 *     connection con el `app.tenant_id` viejo del request anterior → **leak
 *     catastrófico cross-tenant**.
 *   - `SET LOCAL` se resetea al final de la tx, garantizando aislamiento.
 *
 * Convención: **TODA query multi-tenant debe correr dentro de `runWithTenant`**.
 */

const TENANT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Setea el tenant context dentro de la transacción dada. Debe llamarse al
 * inicio de la transacción ANTES de cualquier otra query.
 *
 * @throws BadRequestException si el tenantId no tiene formato UUID válido
 *   (defensivo contra SQL injection — aunque ya usamos parameter binding,
 *   prefiero rechazar input mal formado temprano).
 */
export async function setTenantContext(
  trx: Knex.Transaction,
  tenantId: string,
): Promise<void> {
  if (!tenantId || !TENANT_UUID_REGEX.test(tenantId)) {
    throw new BadRequestException(
      `tenantId inválido (debe ser UUID): "${tenantId}"`,
    );
  }
  // Parameter binding correcto — el ? va dentro del valor, no como identificador.
  // Postgres NO soporta parámetros en `SET` directamente, así que validamos el
  // formato arriba y interpolamos. El regex garantiza que no haya inyección.
  await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
}

/**
 * Wrapper conveniente: abre una transacción, setea el tenant context, ejecuta
 * el callback con esa transacción, commit/rollback automático.
 *
 * Uso típico desde un service:
 * ```ts
 *   await runWithTenant(this.knex, tenantId, async (trx) => {
 *     return trx('users').select('*'); // RLS filtra automáticamente
 *   });
 * ```
 */
export async function runWithTenant<T>(
  knex: Knex,
  tenantId: string,
  callback: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return knex.transaction(async (trx) => {
    await setTenantContext(trx, tenantId);
    return callback(trx);
  });
}

/**
 * Servicio inyectable que envuelve los helpers anteriores con la connection
 * de la nueva DB ya inyectada. Conveniencia para no tener que inyectar
 * `KNEX_NEW_DB` en cada service.
 *
 * Uso:
 * ```ts
 *   constructor(private tenantKnex: TenantKnexService) {}
 *
 *   async getUsersForTenant(tenantId: string) {
 *     return this.tenantKnex.run(tenantId, async (trx) => {
 *       return trx('users').select('*');
 *     });
 *   }
 * ```
 */
@Injectable()
export class TenantKnexService {
  private readonly logger = new Logger(TenantKnexService.name);

  constructor(
    @Inject(KNEX_NEW_DB_TOKEN) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Ejecuta `callback` dentro de una transacción con `app.tenant_id` seteado.
   * Si NO se pasa tenantId explícito, lo lee del AsyncLocalStorage (poblado
   * por TenantContextInterceptor al inicio del request). Si tampoco hay
   * context activo, lanza.
   */
  async run<T>(
    callbackOrTenantId: ((trx: Knex.Transaction) => Promise<T>) | string,
    callback?: (trx: Knex.Transaction) => Promise<T>,
  ): Promise<T> {
    // Overload: run(tenantId, callback) o run(callback)
    let tenantId: string;
    let cb: (trx: Knex.Transaction) => Promise<T>;
    if (typeof callbackOrTenantId === 'string') {
      tenantId = callbackOrTenantId;
      cb = callback!;
    } else {
      tenantId = this.tenantCtx.requireTenantId();
      cb = callbackOrTenantId;
    }
    return runWithTenant(this.knex, tenantId, cb);
  }

  /**
   * Acceso directo al Knex de la nueva DB SIN tenant context.
   * Usar solo para queries globales (ej: tabla `tenants` que es la raíz).
   */
  get global(): Knex {
    return this.knex;
  }
}
