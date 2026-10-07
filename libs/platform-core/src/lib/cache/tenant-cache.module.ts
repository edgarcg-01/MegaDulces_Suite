import { Global, Module } from '@nestjs/common';
import { TenantCacheService } from './tenant-cache.service';

/**
 * Provee TenantCacheService globalmente. Requiere que AppModule registre
 * CacheModule (@nestjs/cache-manager) con isGlobal:true → CACHE_MANAGER queda
 * disponible para inyectar acá. TenantContextService viene de TenantModule
 * (@Global), con @Optional en el service por si el toggle multitenant está off.
 */
@Global()
@Module({
  providers: [TenantCacheService],
  exports: [TenantCacheService],
})
export class TenantCacheModule {}
