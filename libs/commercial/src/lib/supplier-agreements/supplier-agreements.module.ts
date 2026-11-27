import { Module } from '@nestjs/common';
import { SupplierAgreementsController } from './supplier-agreements.controller';
import { SupplierAgreementsService } from './supplier-agreements.service';

// `[PQ.3.10]` Compras › Proveedores › Acuerdos: lo que se decide en una reunión, con dueño y fecha (anexo C §10.20).
// TenantKnexService y TenantContextService vienen del módulo global de plataforma, como en SupplierMeetingsModule.
@Module({
  controllers: [SupplierAgreementsController],
  providers: [SupplierAgreementsService],
})
export class SupplierAgreementsModule {}
