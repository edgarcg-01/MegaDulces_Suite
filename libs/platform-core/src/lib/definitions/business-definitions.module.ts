import { Module } from '@nestjs/common';
import { BusinessDefinitionsController } from './business-definitions.controller';
import { BusinessDefinitionsService } from './business-definitions.service';

/**
 * `[DP.2.1]` Definiciones de negocio (Fase DP). `TenantKnexService` y `TenantContextService` llegan
 * de los módulos globales de base y tenant; el servicio se exporta para que un consumidor del
 * servidor (el motor de comisiones) resuelva una regla con `resolver(key, fecha)`.
 */
@Module({
  controllers: [BusinessDefinitionsController],
  providers: [BusinessDefinitionsService],
  exports: [BusinessDefinitionsService],
})
export class BusinessDefinitionsModule {}
