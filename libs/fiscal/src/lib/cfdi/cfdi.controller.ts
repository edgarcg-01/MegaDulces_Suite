import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CfdiService, CfdiListFilters } from './cfdi.service';

/** FISCAL.4.2 — API de lectura del almacén CFDI 4.0 (fiscal.cfdis). */
@ApiTags('fiscal-cfdi')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/cfdi')
export class CfdiController {
  constructor(private readonly svc: CfdiService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @ApiOperation({ summary: 'Lista CFDI (filtros: fechas, RFC emisor/receptor, tipo, método de pago, rol, búsqueda).' })
  list(@Query() q: CfdiListFilters) { return this.svc.list(q); }

  @Get('stats')
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @ApiOperation({ summary: 'Resumen: conteo/monto por tipo de comprobante y método de pago.' })
  stats(@Query() q: CfdiListFilters) { return this.svc.stats(q); }

  @Get(':id')
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @ApiOperation({ summary: 'Detalle de un CFDI por id o UUID.' })
  get(@Param('id') id: string) { return this.svc.get(id); }
}
