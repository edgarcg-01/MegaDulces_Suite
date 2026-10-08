import { Module } from '@nestjs/common';
import { CommercialCommissionsService } from './commercial-commissions.service';
import { CommissionRecalcService } from './commission-recalc.service';
import { CommissionContrastService } from './commission-contrast.service';
import { CommercialCommissionsController } from './commercial-commissions.controller';

/**
 * RD.6 / RD.17-RD.22 — motor de comisiones de Ruta Directa. Ver el header del service.
 *
 * ⛔ **Aca vivia un `@Cron` y ya no vive.** `CommissionRunnerService` (RD.20/RD.21) calculaba la
 * quincena cerrada a las 08:30 y refrescaba la que corria cada 30 min. Se retiro el 2026-10-07:
 * una quincena cerrada es un valor estatico -- se calcula una vez y no cambia -- y la que corre
 * no se guarda. Lo reemplaza `CommissionRecalcService`, que es el mismo trabajo disparado a
 * proposito: calcular desde una quincena hacia adelante.
 */
@Module({
  controllers: [CommercialCommissionsController],
  providers: [CommercialCommissionsService, CommissionRecalcService, CommissionContrastService],
  exports: [CommercialCommissionsService, CommissionRecalcService, CommissionContrastService],
})
export class CommercialCommissionsModule {}
