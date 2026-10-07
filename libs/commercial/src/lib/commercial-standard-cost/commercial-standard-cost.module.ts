import { Module } from '@nestjs/common';
import { StandardCostService } from './standard-cost.service';
import { StandardCostController } from './standard-cost.controller';

/**
 * `[CE.2]` — Costo estándar de Kepler por producto (sólo lectura sobre `analytics`).
 *
 * Sin `imports`: `TenantKnexService` es global. Se wirea en `AppModule` bajo el toggle
 * `ENABLE_MULTITENANT`, como el resto de `libs/commercial`.
 */
@Module({
  controllers: [StandardCostController],
  providers: [StandardCostService],
  exports: [StandardCostService],
})
export class CommercialStandardCostModule {}
