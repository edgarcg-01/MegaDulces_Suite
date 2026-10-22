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

  /**
   * `[RA-UX.11c]` **Tope para cada operación con Redis.** «Nunca rompe el request» se cumplía sólo
   * si Redis FALLABA; si se TRABA, la promesa no se resuelve nunca y el request se queda colgado.
   * Medido el 2026-10-22: una API levantada sin Redis (cliente esperando conexión, sin error) dejó
   * `/compras/pedido` cargando para siempre — y como ese caché se consulta DENTRO de una transacción
   * de la base, con la transacción abierta («idle in transaction») mientras tanto. Con el tope, un
   * Redis que no contesta cuenta como «no hay caché» y se calcula como si no existiera.
   * Un Redis sano contesta en milisegundos; 250 ms es holgura, no espera.
   */
  static readonly TOPE_MS = 250;
  private static readonly SIN_RESPUESTA = Symbol('sin-respuesta');
  private ultimoAviso = 0;

  /** La operación o, si no contesta a tiempo, `SIN_RESPUESTA`. Su rechazo tardío no queda suelto. */
  private conTope<R>(p: Promise<R>): Promise<R | typeof TenantCacheService.SIN_RESPUESTA> {
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const vence = new Promise<typeof TenantCacheService.SIN_RESPUESTA>((res) => {
      reloj = setTimeout(() => res(TenantCacheService.SIN_RESPUESTA), TenantCacheService.TOPE_MS);
    });
    p.catch(() => undefined);   // si pierde la carrera y después falla, no es un rechazo sin manejar
    return Promise.race([p, vence]).finally(() => clearTimeout(reloj));
  }
  /** Un aviso por minuto como mucho: con Redis caído, cada request lo diría. */
  private avisarSinRespuesta(op: string, k: string): void {
    const ahora = Date.now();
    if (ahora - this.ultimoAviso < 60_000) return;
    this.ultimoAviso = ahora;
    this.logger.warn(`cache ${op} sin respuesta en ${TenantCacheService.TOPE_MS} ms (${k}) — sigo sin cache`);
  }

  /** Devuelve del cache o computa+guarda. Nunca lanza por fallo de cache, ni espera a un cache trabado. */
  async getOrSet<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const k = this.key(key);
    try {
      const hit = await this.conTope(this.cache.get<T>(k));
      if (hit === TenantCacheService.SIN_RESPUESTA) this.avisarSinRespuesta('get', k);
      else if (hit !== undefined && hit !== null) return hit;
    } catch (e) {
      this.logger.warn(`cache get falló (${k}): ${(e as Error).message} — sigo sin cache`);
    }
    const val = await producer();
    try {
      const r = await this.conTope(this.cache.set(k, val, ttlMs));
      if (r === TenantCacheService.SIN_RESPUESTA) this.avisarSinRespuesta('set', k);
    } catch (e) {
      this.logger.warn(`cache set falló (${k}): ${(e as Error).message}`);
    }
    return val;
  }

  /** Invalidá una key del tenant actual (llamar tras un write que la afecta). */
  async invalidate(key: string): Promise<void> {
    try {
      const r = await this.conTope(this.cache.del(this.key(key)));
      if (r === TenantCacheService.SIN_RESPUESTA) this.avisarSinRespuesta('del', key);
    } catch (e) {
      this.logger.warn(`cache del falló: ${(e as Error).message}`);
    }
  }
}
