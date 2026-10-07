import { Module } from '@nestjs/common';
import { EntityRefService } from './entity-ref.service';
import { EntityRefController } from './entity-ref.controller';

/**
 * Resolvedor universal de referencias ("todo es clickeable").
 * Módulo propio y sin dependencias de otros módulos de negocio: solo necesita
 * TenantKnexService/TenantContextService, que vienen del módulo global de platform-core.
 */
@Module({
  controllers: [EntityRefController],
  providers: [EntityRefService],
  exports: [EntityRefService],
})
export class EntityRefModule {}
