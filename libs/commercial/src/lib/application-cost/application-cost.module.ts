import { Module } from '@nestjs/common';
import { ApplicationCostController } from './application-cost.controller';
import { ApplicationCostService } from './application-cost.service';

// `[PQ.157]` Compras › validar el costo al aplicar: los renglones de una aplicación contra su OC y la decisión por renglón.
// TenantKnexService, TenantContextService y ScopeService vienen del módulo global de plataforma, como en PurchaseCalendarModule.
@Module({
  controllers: [ApplicationCostController],
  providers: [ApplicationCostService],
})
export class ApplicationCostModule {}
