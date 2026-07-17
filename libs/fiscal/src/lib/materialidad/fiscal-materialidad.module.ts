import { Module } from '@nestjs/common';
import { MaterialidadService } from './materialidad.service';
import { MaterialidadAssignmentsService } from './materialidad-assignments.service';
import { MaterialidadController } from './materialidad.controller';

/**
 * FISCAL.10.1 (libs/fiscal) — Expediente de materialidad.
 * Reúne listas SAT + CFDIs + cadena de suministro (analytics.expense_doc_chain)
 * para defender operaciones con proveedores (clave si son EFOS). MAT.1: asignación
 * CFDI↔operación confirmada por humano (fiscal.cfdi_assignments).
 */
@Module({
  controllers: [MaterialidadController],
  providers: [MaterialidadService, MaterialidadAssignmentsService],
  exports: [MaterialidadService, MaterialidadAssignmentsService],
})
export class FiscalMaterialidadModule {}
