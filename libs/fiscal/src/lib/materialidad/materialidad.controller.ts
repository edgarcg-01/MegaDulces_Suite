import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MaterialidadService } from './materialidad.service';

/** FISCAL.10.1 — API del expediente de materialidad por proveedor. */
@ApiTags('fiscal-materialidad')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/materialidad')
export class MaterialidadController {
  constructor(private readonly svc: MaterialidadService) {}

  @Get(':rfc')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_VER)
  @ApiOperation({ summary: 'Expediente de materialidad de un proveedor (listas + CFDIs + cadena de suministro + veredicto).' })
  dossier(@Param('rfc') rfc: string) { return this.svc.buildDossier(rfc); }

  @Get(':rfc/chains')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_VER)
  @ApiOperation({ summary: 'Desglose de la cadena de suministro: documentos (orden → recepción → factura → pago) por cada factura del proveedor.' })
  chains(@Param('rfc') rfc: string) { return this.svc.chains(rfc); }
}
