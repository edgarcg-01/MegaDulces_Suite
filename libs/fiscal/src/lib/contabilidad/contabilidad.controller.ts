import { Body, Controller, Delete, Get, Header, Post, Put, Query, UseGuards } from '@nestjs/common';
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

  // ── FE.11: mapeo cuenta mayor → código agrupador SAT ────────────────────────

  @Get('cod-agrupador')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'FE.11: cuentas mayor de la balanza con su mapeo al código agrupador SAT (null si sin mapear).' })
  listCodAgrupador() {
    return this.svc.listCodAgrupador();
  }

  @Post('cod-agrupador/suggest')
  @RequirePermissions(Permission.FISCAL_CONTAB_GESTIONAR)
  @ApiOperation({ summary: 'FE.11: auto-siembra un mapeo (source=auto) para las cuentas mayor sin mapear. Idempotente.' })
  suggestCodAgrupador() {
    return this.svc.suggestCodAgrupador();
  }

  @Put('cod-agrupador')
  @RequirePermissions(Permission.FISCAL_CONTAB_GESTIONAR)
  @ApiOperation({ summary: 'FE.11: set/override manual de un mapeo cuenta mayor → código agrupador SAT.' })
  upsertCodAgrupador(@Body() body: { cuenta_mayor: string; cod_agrupador: string; natur?: string | null }) {
    return this.svc.upsertCodAgrupador(body);
  }

  @Delete('cod-agrupador')
  @RequirePermissions(Permission.FISCAL_CONTAB_GESTIONAR)
  @ApiOperation({ summary: 'FE.11: elimina el mapeo de una cuenta mayor (vuelve al placeholder).' })
  deleteCodAgrupador(@Query('cuenta_mayor') cuentaMayor: string) {
    return this.svc.deleteCodAgrupador(cuentaMayor);
  }
}
