import { Module } from '@nestjs/common';
import { CommercialMovementsModule } from '../commercial-movements/commercial-movements.module';
import { CommercialBiAlmacenService } from './commercial-bi-almacen.service';
import { CommercialBiAlmacenController } from './commercial-bi-almacen.controller';

/**
 * WMS-BI — Análisis BI de Almacén. Importa `CommercialMovementsModule` para reusar
 * `CommercialMovementsService.document()` en el drill de un folio (misma tabla, misma
 * lógica de armar header/líneas/contraparte — no se duplica). `ScopeService` viene de
 * `@Global() ScopeModule` (ADR-050): no hace falta importarlo acá.
 */
@Module({
  imports: [CommercialMovementsModule],
  controllers: [CommercialBiAlmacenController],
  providers: [CommercialBiAlmacenService],
  exports: [CommercialBiAlmacenService],
})
export class CommercialBiAlmacenModule {}
