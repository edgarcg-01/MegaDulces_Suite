import { Module } from '@nestjs/common';
import { CommercialCommissionsService } from './commercial-commissions.service';
import { CommissionRunnerService } from './commission-runner.service';
import { CommercialCommissionsController } from './commercial-commissions.controller';

/**
 * RD.6 / RD.17-RD.20 — motor de comisiones de Ruta Directa. Ver el header del service.
 *
 * `CommissionRunnerService` es el `@Cron` que calcula la quincena al cerrar (RD.20). Existe
 * porque el motor llevaba un mes desplegado con **cero corridas**: calcular dependia de que
 * alguien se acordara, y la costumbre del Excel ganaba. No aprueba ni paga.
 */
@Module({
  controllers: [CommercialCommissionsController],
  providers: [CommercialCommissionsService, CommissionRunnerService],
  exports: [CommercialCommissionsService, CommissionRunnerService],
})
export class CommercialCommissionsModule {}
