import { Module } from '@nestjs/common';
import { CommercialMovementsService } from './commercial-movements.service';
import { CommercialMovementsController } from './commercial-movements.controller';
import { MovementsExportService } from './movements-export.service';
import { NegativeStockService } from './negative-stock.service';
import { NegativeStockController } from './negative-stock.controller';

/**
 * DM — Diario de movimientos (mejora del reporte Kepler homónimo).
 * Lee analytics.stock_movements (feed de import-stock-movements.js).
 * TenantKnexService/TenantContextService vienen del módulo global de platform-core.
 * [MX.2.8] NegativeStockService: la sección «Existencia negativa» de /almacen/incidencias.
 */
@Module({
  controllers: [CommercialMovementsController, NegativeStockController],
  providers: [CommercialMovementsService, MovementsExportService, NegativeStockService],
  exports: [CommercialMovementsService],
})
export class CommercialMovementsModule {}
