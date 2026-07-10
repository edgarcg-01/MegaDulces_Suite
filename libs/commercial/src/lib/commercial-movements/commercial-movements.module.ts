import { Module } from '@nestjs/common';
import { CommercialMovementsService } from './commercial-movements.service';
import { CommercialMovementsController } from './commercial-movements.controller';

/**
 * DM — Diario de movimientos (mejora del reporte Kepler homónimo).
 * Lee analytics.stock_movements (feed de import-stock-movements.js).
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 */
@Module({
  controllers: [CommercialMovementsController],
  providers: [CommercialMovementsService],
  exports: [CommercialMovementsService],
})
export class CommercialMovementsModule {}
