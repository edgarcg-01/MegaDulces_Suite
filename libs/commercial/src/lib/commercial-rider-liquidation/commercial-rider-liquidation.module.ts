import { Module } from '@nestjs/common';
import { CommercialRiderLiquidationController } from './commercial-rider-liquidation.controller';
import { CommercialRiderLiquidationService } from './commercial-rider-liquidation.service';

/**
 * Fase LM.5 — corte de caja del repartidor (arqueo + cuadre de efectivo).
 * Computa totales desde commercial.payments; TenantKnexService/TenantContextService globales.
 */
@Module({
  controllers: [CommercialRiderLiquidationController],
  providers: [CommercialRiderLiquidationService],
  exports: [CommercialRiderLiquidationService],
})
export class CommercialRiderLiquidationModule {}
