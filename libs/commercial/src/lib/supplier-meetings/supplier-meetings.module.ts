import { Module } from '@nestjs/common';
import { SupplierMeetingsController } from './supplier-meetings.controller';
import { SupplierMeetingsService } from './supplier-meetings.service';

// `[PQ.3.8]` Compras › Proveedores › Citas: la agenda de reuniones con el proveedor (anexo C §9.1).
// TenantKnexService y TenantContextService vienen del módulo global de plataforma, como en PurchaseCalendarModule.
@Module({
  controllers: [SupplierMeetingsController],
  providers: [SupplierMeetingsService],
})
export class SupplierMeetingsModule {}
