import { Controller, Get, Header, Param, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CfdiService, type CfdiListFilters } from './cfdi.service';

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

  @Get('export.zip')
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @ApiOperation({ summary: 'MAT — Exporta un ZIP con los XML agrupados en carpetas por RFC (+ _index.csv). Mismos filtros que la lista.' })
  async exportZip(@Query() q: CfdiListFilters, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { buffer, filename } = await this.svc.exportZip(q);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(buffer);
  }

  @Get(':id/xml')
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @Header('Content-Type', 'application/xml')
  @ApiOperation({ summary: 'MAT.0 — descarga el XML del CFDI (documento guardado).' })
  xml(@Param('id') id: string) { return this.svc.getXml(id); }

  @Get(':id')
  @RequirePermissions(Permission.FISCAL_CFDI_VER)
  @ApiOperation({ summary: 'Detalle de un CFDI por id o UUID.' })
  get(@Param('id') id: string) { return this.svc.get(id); }
}
