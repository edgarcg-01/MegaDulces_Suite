import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
import { SupplierPaymentAccountsService } from './supplier-payment-accounts.service';
import { SupplierPaymentAccountsController } from './supplier-payment-accounts.controller';

/**
 * Fase TP.7 (ADR-064) — Catálogo de cuentas de pago a proveedor + workflow de aprobación.
 *
 * `CloudinaryModule` es quien EXPORTA `ObjectStorageService` (el adjunto JPG/PDF de la
 * solicitud de alta/cambio). Se importa el módulo en vez de declarar el servicio en
 * `providers`: así se comparte la instancia en lugar de crear una segunda en este
 * inyector. Sin esto la API no arranca — Nest no resuelve el 3er parámetro del service.
 */
@Module({
  imports: [CloudinaryModule],
  controllers: [SupplierPaymentAccountsController],
  providers: [SupplierPaymentAccountsService],
  exports: [SupplierPaymentAccountsService],
})
export class CommercialSupplierPaymentAccountsModule {}
