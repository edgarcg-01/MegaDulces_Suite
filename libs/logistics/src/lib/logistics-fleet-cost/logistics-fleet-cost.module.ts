import { Module } from '@nestjs/common';
import { CostoUnidadController } from './costo-unidad.controller';
import { CostoUnidadService } from './costo-unidad.service';

// [FCU] Logística › Costo por unidad: lo que hacía la hoja «TRANSPORTES 2026», con pantalla.
@Module({
  controllers: [CostoUnidadController],
  providers: [CostoUnidadService],
  exports: [CostoUnidadService],
})
export class LogisticsFleetCostModule {}
