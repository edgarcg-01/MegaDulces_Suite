import { Module } from '@nestjs/common';
import { CommercialVendorSalesController } from './commercial-vendor-sales.controller';
import { CommercialVendorSalesService } from './commercial-vendor-sales.service';

/**
 * Líneas de venta de la captura del vendedor. Sin upload (la foto llega ya
 * subida por /ai/ticket/extract) → solo persiste. TenantKnexService/
 * TenantContextService son globales.
 */
@Module({
  imports: [],
  controllers: [CommercialVendorSalesController],
  providers: [CommercialVendorSalesService],
})
export class CommercialVendorSalesModule {}
