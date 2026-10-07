import { Global, Module } from '@nestjs/common';
import { PermissionsCacheService } from './permissions-cache.service';

/**
 * Módulo global para el cache de permisos. Marcado `@Global()` para que
 * cualquier guard, service o controller pueda inyectar `PermissionsCacheService`
 * sin necesidad de importar este módulo en cada feature module.
 */
@Global()
@Module({
  providers: [PermissionsCacheService],
  exports: [PermissionsCacheService],
})
export class AbilityModule {}
