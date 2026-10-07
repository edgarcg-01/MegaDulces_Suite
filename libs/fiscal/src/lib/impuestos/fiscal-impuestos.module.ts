import { Module } from '@nestjs/common';
import { FiscalDiotModule } from '../diot/fiscal-diot.module';
import { ImpuestosService } from './impuestos.service';
import { ImpuestosController } from './impuestos.controller';

/**
 * FISCAL.18 (libs/fiscal) — Impuestos provisionales (ISR + IVA).
 * ISR desde balanza (ingresos × coeficiente de utilidad, input del ejercicio
 * anterior); IVA reusa DiotService (flujo efectivo). Cálculo de apoyo. Sin tablas.
 */
@Module({
  imports: [FiscalDiotModule],
  controllers: [ImpuestosController],
  providers: [ImpuestosService],
  exports: [ImpuestosService],
})
export class FiscalImpuestosModule {}
