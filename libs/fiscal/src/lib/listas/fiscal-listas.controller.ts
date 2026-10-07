import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { FiscalListasService } from './fiscal-listas.service';
import { SatListCrossService } from './sat-list-cross.service';
import { RfcValidationService } from './rfc-validation.service';
import { FiscalListasScannerService } from './fiscal-listas-scanner.service';
import { FiscalFindingsBridgeService } from './fiscal-findings-bridge.service';

/**
 * FISCAL.0/1 — API del motor de listas SAT (69-B, 69) + validación de RFC.
 *   VER       ← FISCAL_LISTAS_VER
 *   GESTIONAR ← FISCAL_LISTAS_GESTIONAR (triage + disparar scan/refresh)
 */
@ApiTags('fiscal-listas')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/listas')
export class FiscalListasController {
  constructor(
    private readonly svc: FiscalListasService,
    private readonly cross: SatListCrossService,
    private readonly rfc: RfcValidationService,
    private readonly scanner: FiscalListasScannerService,
    private readonly bridge: FiscalFindingsBridgeService,
  ) {}

  @Get('matches')
  @RequirePermissions(Permission.FISCAL_LISTAS_VER)
  @ApiOperation({ summary: 'Bandeja de proveedores del tenant en listas SAT. Filtros: lista(69B|69), situacion, estado, limit.' })
  matches(
    @Query('lista') lista?: string,
    @Query('situacion') situacion?: string,
    @Query('estado') estado?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.matches({ lista, situacion, estado, limit: limit ? Number(limit) : undefined });
  }

  @Get('stats')
  @RequirePermissions(Permission.FISCAL_LISTAS_VER)
  @ApiOperation({ summary: 'KPIs: exposición en riesgo, conteos por lista/situación + RFC issues.' })
  stats() { return this.svc.stats(); }

  @Get('status')
  @RequirePermissions(Permission.FISCAL_LISTAS_VER)
  @ApiOperation({ summary: 'Estado de cada lista cargada (hash, fecha, edad, total RFCs).' })
  status() { return this.svc.listStatus(); }

  @Get('matches/:rfc/documents')
  @RequirePermissions(Permission.FISCAL_LISTAS_VER)
  @ApiOperation({ summary: 'Drill: documentos (pólizas) del tenant con ese proveedor.' })
  documents(@Param('rfc') rfc: string) { return this.svc.documents(rfc); }

  @Get('rfc-issues')
  @RequirePermissions(Permission.FISCAL_LISTAS_VER)
  @ApiOperation({ summary: 'Bandeja de RFC de proveedor con problema estructural (formato_invalido|rfc_generico).' })
  rfcIssues(@Query('issue_type') issueType?: string, @Query('estado') estado?: string, @Query('limit') limit?: string) {
    return this.svc.rfcIssues({ issue_type: issueType, estado, limit: limit ? Number(limit) : undefined });
  }

  @Patch('matches/:id/estado')
  @RequirePermissions(Permission.FISCAL_LISTAS_GESTIONAR)
  @ApiOperation({ summary: 'Triage de un match de lista (nuevo|en_revision|confirmado|descartado).' })
  setMatchEstado(@Param('id') id: string, @Body() body: { estado: string; nota?: string }) {
    return this.svc.setMatchEstado(id, body.estado, body.nota);
  }

  @Patch('rfc-issues/:id/estado')
  @RequirePermissions(Permission.FISCAL_LISTAS_GESTIONAR)
  @ApiOperation({ summary: 'Triage de un RFC issue.' })
  setIssueEstado(@Param('id') id: string, @Body() body: { estado: string; nota?: string }) {
    return this.svc.setIssueEstado(id, body.estado, body.nota);
  }

  @Post('scan')
  @RequirePermissions(Permission.FISCAL_LISTAS_GESTIONAR)
  @Throttle({ long: { limit: 4, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cruza todas las listas + valida RFCs + consolida en Maat para el tenant actual (idempotente).' })
  async scan() {
    const listas = await this.cross.crossAllCurrent();
    const rfc = await this.rfc.validateCurrent();
    const maat = await this.bridge.syncCurrent();
    return { listas, rfc, maat };
  }

  @Post('refresh')
  @RequirePermissions(Permission.FISCAL_LISTAS_GESTIONAR)
  @Throttle({ long: { limit: 2, ttl: 60_000 } })
  @ApiOperation({ summary: 'Descarga todas las listas del SAT + cruce/validación de todos los tenants.' })
  refresh() { return this.scanner.runFullScan('manual'); }
}
