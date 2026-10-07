import { Module } from '@nestjs/common';
import { PosLineVoidsService } from './pos-line-voids.service';
import { PosLineVoidsController } from './pos-line-voids.controller';

/**
 * `[BP.5]` — Bitácora de retiros en caja: el renglón que el cajero quitó del ticket.
 *
 * Sin `imports`: `TenantKnexService`, `TenantContextService` y `ScopeService` son globales.
 * Se wirea en `AppModule` bajo el toggle `ENABLE_MULTITENANT`, como el resto de `libs/commercial`.
 */
@Module({
  controllers: [PosLineVoidsController],
  providers: [PosLineVoidsService],
  exports: [PosLineVoidsService],
})
export class CommercialPosVoidsModule {}
