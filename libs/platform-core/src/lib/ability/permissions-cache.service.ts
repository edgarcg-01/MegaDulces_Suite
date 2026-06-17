import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../database/database.module';

/**
 * Cache en memoria de permisos por rol. Razones del diseño:
 *
 * - **Por `(tenant_id, role_name)`, no por `user_id`**: muchos usuarios comparten
 *   el mismo rol (50 capturistas → 1 sola entrada). El `tenant_id` es OBLIGATORIO
 *   en la key y en la query: el mismo `role_name` (p.ej. `superadmin`) existe en
 *   cada tenant con permisos distintos, y `role_permissions` tiene UNIQUE
 *   (tenant_id, role_name). Sin el tenant, `.first()` sobre duplicados es
 *   no-determinista → un tenant podía leer los permisos de otro (incidente
 *   2026-06-16: superoot 403 al leer un superadmin de otro tenant).
 * - **TTL corto (30s)**: en el peor caso un revoke tarda ~30s en propagarse
 *   sin necesidad de invalidación explícita. El logout/login no es necesario.
 * - **Invalidación explícita en update**: al cambiar permisos desde
 *   `/admin/catalogs/roles`, el service llama `invalidate(roleName)` y el
 *   próximo request rebuildea desde DB → 0 latencia para el admin que edita.
 * - **Sin Redis**: la app corre como instancia única en Railway; un Map en
 *   memoria es suficiente. Si en el futuro hay multi-instancia, migrar a
 *   Redis con pub/sub para coordinar invalidaciones.
 */

interface CacheEntry {
  permissions: Record<string, boolean>;
  expiresAt: number;
}

const TTL_MS = 30_000;

@Injectable()
export class PermissionsCacheService {
  private readonly logger = new Logger(PermissionsCacheService.name);
  private cache = new Map<string, CacheEntry>();

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Devuelve el JSONB de permisos del rol. Hit del cache si vigente,
   * miss → query a `role_permissions` + set en cache.
   */
  async getPermissionsForRole(
    roleName: string,
    tenantId?: string,
  ): Promise<Record<string, boolean>> {
    if (!roleName) return {};
    const now = Date.now();
    const key = `${tenantId ?? 'global'}:${roleName}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.permissions;
    }
    // tenant_id OBLIGATORIO para aislar: sin él, `.first()` sobre el mismo
    // role_name en varios tenants es no-determinista (cross-tenant leak).
    const q = this.knex('role_permissions').where({ role_name: roleName });
    if (tenantId) q.where({ tenant_id: tenantId });
    const row = await q.first();
    const permissions: Record<string, boolean> = row?.permissions ?? {};
    this.cache.set(key, { permissions, expiresAt: now + TTL_MS });
    return permissions;
  }

  /**
   * Llamar tras `updateRolePermissions` para propagar el cambio inmediatamente
   * a TODOS los usuarios con ese rol en su próximo request.
   */
  invalidate(roleName: string, tenantId?: string): void {
    if (tenantId) {
      if (this.cache.delete(`${tenantId}:${roleName}`)) {
        this.logger.log(`Cache invalidated for "${tenantId}:${roleName}"`);
      }
      return;
    }
    // Sin tenant: invalidar la entrada de ese rol en TODOS los tenants cacheados.
    let n = 0;
    for (const k of [...this.cache.keys()]) {
      const parts = k.split(':');
      const kRole = parts.length > 1 ? parts.slice(1).join(':') : k;
      if (kRole === roleName) {
        this.cache.delete(k);
        n++;
      }
    }
    if (n) this.logger.log(`Cache invalidated for role "${roleName}" (${n} entradas)`);
  }

  /** Util de debug — no usar en runtime normal. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
