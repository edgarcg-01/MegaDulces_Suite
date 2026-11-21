import { Module } from '@nestjs/common';
import { PurchaseCalendarController } from './purchase-calendar.controller';
import { PurchaseCalendarService } from './purchase-calendar.service';

// `[PQ.3.4]` Compras › Calendario de compras: reglas de revisión por alcance y la marca del día (anexo C §10).
// TenantKnexService y TenantContextService vienen del módulo global de plataforma, como en TemporadasModule.
@Module({
  controllers: [PurchaseCalendarController],
  providers: [PurchaseCalendarService],
})
export class PurchaseCalendarModule {}
