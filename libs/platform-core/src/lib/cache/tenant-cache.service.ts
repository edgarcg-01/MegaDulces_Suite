import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { TenantContextService } from '../tenant/tenant-context.service';

/**
 * Cache tenant-aware sobre @nestjs/cache-manager (Redis vía Keyv, ver AppModule).
 *
 * ⚠️ POR QUÉ NO usar el CacheInterceptor global de NestJS: cachea por URL, y en
 * esta app multi-tenant eso serviría los datos cacheados del tenant A al tenant B
 * (fuga cross-tenant — ya pasó una vez con PermissionsCache). Este helper
 * PREFIJA la key con el `tenant_id` del contexto (AsyncLocalStorage) → cada
 * tenant tiene su propio espacio de cache.
 *
 * Degrada con gracia: si Redis falla, computa igual (nunca rompe el request).
 *
 * Uso (en un service):
 *   constructor(private cache: TenantCacheService) {}
 *   async getOverview() {
 *     return this.cache.getOrSet('analytics:overview', 60_000, () => this.compute());
 *   }
 *
 * TTL en MILISEGUNDOS (cache-manager v6+). Usá TTL corto (30-120s) en reads que
 * cambian; sin cache en escrituras (o invalidá con invalidate() tras el write).
 */
@Injectable()
export class TenantCacheService {
  private readonly logger = new Logger(TenantCacheService.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    // @Optional: si ENABLE_MULTITENANT está off, TenantContextService no existe.
    @Optional() private readonly tenant?: TenantContextService,
  ) {}

  private key(k: string): string {
    const t = this.tenant?.get()?.tenantId ?? 'no-tenant';
    return `t:${t}:${k}`;
  }

  /** Devuelve del cache o computa+guarda. Nunca lanza por fallo de cache. */
  async getOrSet<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const k = this.key(key);
    try {
      const hit = await this.cache.get<T>(k);
      if (hit !== undefined && hit !== null) return hit;
    } catch (e) {
      this.logger.warn(`cache get falló (${k}): ${(e as Error).message} — sigo sin cache`);
    }
    const val = await producer();
    try {
      await this.cache.set(k, val, ttlMs);
    } catch (e) {
      this.logger.warn(`cache set falló (${k}): ${(e as Error).message}`);
    }
    return val;
  }

  /** Invalidá una key del tenant actual (llamar tras un write que la afecta). */
  async invalidate(key: string): Promise<void> {
    try {
      await this.cache.del(this.key(key));
    } catch (e) {
      this.logger.warn(`cache del falló: ${(e as Error).message}`);
    }
  }
}
