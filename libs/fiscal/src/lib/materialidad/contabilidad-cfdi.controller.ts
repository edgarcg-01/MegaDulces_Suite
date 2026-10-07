import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CfdiContabilidadService } from './cfdi-contabilidad.service';

/**
 * CP.8 (Fase CP, ADR-040) — CFDI ↔ Contabilidad (ContPAQi). Vive en Contabilidad:
 * cruza los CFDI recibidos del periodo contra el padrón de proveedores de la contabilidad
 * y la lista negra del SAT → riesgo de deducibilidad / materialidad cuantificado.
 */
@ApiTags('contabilidad-contpaqi')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('contabilidad/cfdi-vs-contabilidad')
export class ContabilidadCfdiController {
  constructor(private readonly svc: CfdiContabilidadService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'CFDI recibidos del periodo vs padrón de proveedores ContPAQi + lista SAT: EFOS/no-deducible, no registrados.' })
  overview(@Query('period') period?: string) { return this.svc.overview(period); }
}
