import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../database/database.module';

/**
 * Cache en memoria de permisos por rol. Razones del diseño:
 *
 * - **Por `role_name`, no por `user_id`**: muchos usuarios comparten el mismo
 *   rol (50 capturistas → 1 sola entrada). Reduce queries y memoria.
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
  ): Promise<Record<string, boolean>> {
    if (!roleName) return {};
    const now = Date.now();
    const cached = this.cache.get(roleName);
    if (cached && cached.expiresAt > now) {
      return cached.permissions;
    }
    const row = await this.knex('role_permissions')
      .where({ role_name: roleName })
      .first();
    const permissions: Record<string, boolean> = row?.permissions ?? {};
    this.cache.set(roleName, { permissions, expiresAt: now + TTL_MS });
    return permissions;
  }

  /**
   * Llamar tras `updateRolePermissions` para propagar el cambio inmediatamente
   * a TODOS los usuarios con ese rol en su próximo request.
   */
  invalidate(roleName: string): void {
    if (this.cache.delete(roleName)) {
      this.logger.log(`Cache invalidated for role "${roleName}"`);
    }
  }

  /** Util de debug — no usar en runtime normal. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
