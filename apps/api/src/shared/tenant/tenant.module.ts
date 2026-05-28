import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TenantContextService } from './tenant-context.service';
import { TenantContextInterceptor } from './tenant-context.interceptor';

/**
 * Módulo global que provee TenantContextService + TenantContextInterceptor.
 *
 * Marcado @Global() para que cualquier service del API pueda inyectar
 * `TenantContextService` sin importar este módulo. El interceptor se registra
 * como APP_INTERCEPTOR en AppModule.
 *
 * JwtModule embedded acá porque el interceptor decodea el Bearer JWT inline
 * (no usamos passport-jwt + guard separado en este punto del cutover).
 */
@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  providers: [TenantContextService, TenantContextInterceptor],
  // Exportamos JwtModule para que JwtAuthGuard (registrado en AppModule)
  // pueda inyectar JwtService sin necesidad de re-importar JwtModule allí.
  exports: [TenantContextService, TenantContextInterceptor, JwtModule],
})
export class TenantModule {}
