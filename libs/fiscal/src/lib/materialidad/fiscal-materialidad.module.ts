import { Module } from '@nestjs/common';
import { MaterialidadService } from './materialidad.service';
import { MaterialidadAssignmentsService } from './materialidad-assignments.service';
import { MaterialidadController } from './materialidad.controller';
import { CfdiContabilidadService } from './cfdi-contabilidad.service';
import { ContabilidadCfdiController } from './contabilidad-cfdi.controller';

/**
 * FISCAL.10.1 (libs/fiscal) — Expediente de materialidad.
 * Reúne listas SAT + CFDIs + cadena de suministro (analytics.expense_doc_chain)
 * para defender operaciones con proveedores (clave si son EFOS). MAT.1: asignación
 * CFDI↔operación confirmada por humano (fiscal.cfdi_assignments).
 */
@Module({
  controllers: [MaterialidadController, ContabilidadCfdiController],
  providers: [MaterialidadService, MaterialidadAssignmentsService, CfdiContabilidadService],
  exports: [MaterialidadService, MaterialidadAssignmentsService],
})
export class FiscalMaterialidadModule {}
