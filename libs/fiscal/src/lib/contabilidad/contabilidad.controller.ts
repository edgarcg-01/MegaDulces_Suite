import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ContabilidadElectronicaService } from './contabilidad-electronica.service';

/** FISCAL.9 — API de contabilidad electrónica (XMLs SAT). Devuelve XML crudo. */
@ApiTags('fiscal-contabilidad-electronica')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/contabilidad-electronica')
export class ContabilidadController {
  constructor(private readonly svc: ContabilidadElectronicaService) {}

  @Get('balanza')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({ summary: 'Balanza de Comprobación XML (SAT BCE 1.3) del periodo YYYY-MM.' })
  balanza(@Query('period') period: string, @Query('tipoEnvio') tipoEnvio?: 'N' | 'C', @Query('rfc') rfc?: string) {
    return this.svc.balanzaXml(period, tipoEnvio === 'C' ? 'C' : 'N', rfc);
  }

  @Get('catalogo')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({ summary: 'Catálogo de Cuentas XML (SAT 1.3) al periodo YYYY-MM.' })
  catalogo(@Query('period') period: string, @Query('rfc') rfc?: string) {
    return this.svc.catalogoXml(period, rfc);
  }
}
