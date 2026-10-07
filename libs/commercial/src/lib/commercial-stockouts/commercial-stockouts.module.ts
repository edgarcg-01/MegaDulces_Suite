import { Module } from '@nestjs/common';
import { FloorStockoutsService } from './floor-stockouts.service';
import { FloorStockoutsController } from './floor-stockouts.controller';

/**
 * `[FLT.5]` — Lista de faltantes: la venta que NO ocurrió, reportada desde el piso.
 *
 * Sin `imports`: `TenantKnexService` y `TenantContextService` son globales, y este módulo no
 * necesita nada más (ni Cloudinary ni LLM — la captura es de cinco segundos a propósito).
 *
 * Se wirea en `AppModule` bajo el toggle `ENABLE_MULTITENANT`, como el resto de `libs/commercial`.
 */
@Module({
  controllers: [FloorStockoutsController],
  providers: [FloorStockoutsService],
  exports: [FloorStockoutsService],
})
export class CommercialStockoutsModule {}
