import { Module } from '@nestjs/common';
import { CommercialCommissionsService } from './commercial-commissions.service';
import { CommissionRecalcService } from './commission-recalc.service';
import { CommissionContrastService } from './commission-contrast.service';
import { CommissionObjectiveService } from './commission-objective.service';
import { CommissionPadronService } from './commission-padron.service';
import { CommissionBonosService } from './commission-bonos.service';
import { CommissionAutoRunService } from './commission-auto-run.service';
import { CommercialCommissionsController } from './commercial-commissions.controller';

/**
 * RD.6 / RD.17-RD.22 — motor de comisiones de Ruta Directa. Ver el header del service.
 *
 * ⛔ **Aca vivia un `@Cron` que despertaba 48 VECES AL DIA.** `CommissionRunnerService`
 * (RD.20/RD.21) refrescaba la quincena en curso cada 30 min: una cifra de nomina **moviendose
 * sola**. Se retiro el 2026-10-07 y **eso no vuelve**.
 *
 * ⭐ **Pero desde `[RD.87]` (2026-10-20) hay OTRO cron, y no es el mismo error.**
 * `CommissionAutoRunService` corre **una vez al dia** (07:30 MX) y sólo mira una condicion de
 * fecha: *¿cerró una quincena y nadie la calculo?* Si la fuente de todas las rutas vigentes
 * esta viva, calcula y deja **BORRADOR**; si no, **no calcula** y nombra las rutas. Nunca
 * aprueba ni paga (ADR-016).
 *
 * ⚠️ La diferencia que importa no es la frecuencia: es **que no reescribe nada**. Aquel cron
 * pisaba una corrida viva 48 veces al dia; este crea la que faltaba, una sola vez.
 *
 * `CommissionRecalcService` sigue siendo el camino **a proposito**: calcular desde una quincena
 * hacia adelante cuando cambia el tabulador.
 */
@Module({
  controllers: [CommercialCommissionsController],
  providers: [CommercialCommissionsService, CommissionRecalcService, CommissionContrastService, CommissionObjectiveService, CommissionPadronService, CommissionBonosService, CommissionAutoRunService],
  exports: [CommercialCommissionsService, CommissionRecalcService, CommissionContrastService, CommissionObjectiveService],
})
export class CommercialCommissionsModule {}
