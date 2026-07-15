import { Module } from '@nestjs/common';
import { MaterialidadService } from './materialidad.service';
import { MaterialidadController } from './materialidad.controller';

/**
 * FISCAL.10.1 (libs/fiscal) — Expediente de materialidad.
 * Reúne listas SAT + CFDIs + cadena de suministro (analytics.expense_doc_chain)
 * para defender operaciones con proveedores (clave si son EFOS). Sin tablas nuevas.
 */
@Module({
  controllers: [MaterialidadController],
  providers: [MaterialidadService],
  exports: [MaterialidadService],
})
export class FiscalMaterialidadModule {}
