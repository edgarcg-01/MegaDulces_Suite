import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tenant context propagado vía AsyncLocalStorage (CLS).
 *
 * Usado por:
 *   - TenantContextInterceptor: setea el context al inicio del request
 *   - TenantKnexService: lee el context para inyectar SET LOCAL en cada tx
 *   - Cualquier service downstream que necesite el tenant_id sin pasarlo por args
 *
 * AsyncLocalStorage es nativo de Node 18+ y reemplaza a cls-hooked.
 * Propaga el context a través de promesas y callbacks async automáticamente.
 */

export interface TenantContext {
  tenantId: string;
  userId?: string;
  username?: string;
  roleName?: string;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  /**
   * Ejecuta `callback` dentro de un AsyncLocalStorage scope con el context dado.
   * Todo el código async dentro del callback puede leer el context via `get()`.
   */
  run<T>(context: TenantContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  /**
   * Devuelve el context actual o undefined si no hay scope activo.
   * Llamar fuera de un `run()` retorna undefined (ej: cron jobs sin tenant).
   */
  get(): TenantContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Devuelve el tenantId actual o lanza si no hay context.
   * Útil cuando el código asume que SIEMPRE debe haber tenant.
   */
  requireTenantId(): string {
    const ctx = this.get();
    if (!ctx?.tenantId) {
      throw new Error('TenantContext no seteado — request fuera de scope tenant');
    }
    return ctx.tenantId;
  }
}
