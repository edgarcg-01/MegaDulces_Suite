import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PolizasService } from './polizas.service';
import { MaatDetectorService } from '../maat/maat-detector.service';

/**
 * PV.3 (Fase PV, ADR-041) — API del Auditor de Pólizas. Vive bajo `/contabilidad/*`
 * (proyecto Contabilidad) reusando el permiso FISCAL_CONTAB_VER/_GESTIONAR. Solo lectura
 * + disparo del scan (que corre los detectores deterministas; el LLM sigue fuera).
 */
@ApiTags('contabilidad-polizas')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('contabilidad/polizas')
export class PolizasController {
  constructor(
    private readonly svc: PolizasService,
    private readonly detector: MaatDetectorService,
  ) {}

  @Get('summary')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'KPIs: total de pólizas, descuadradas, monto de descuadre, por fuente.' })
  summary(@Query('source') source?: string) {
    return this.svc.summary(source);
  }

  @Get()
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Lista paginada de pólizas con semáforo de cuadre y filtros.' })
  list(
    @Query('source') source?: string,
    @Query('anio_mes') anio_mes?: string,
    @Query('only_descuadre') only_descuadre?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('page_size') page_size?: string,
  ) {
    return this.svc.list({
      source, anio_mes, q,
      only_descuadre: only_descuadre === 'true' || only_descuadre === '1',
      page: Number(page) || 1, page_size: Number(page_size) || 50,
    });
  }

  @Get('detail')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiOperation({ summary: 'Detalle de una póliza: header + patas (asientos) + CFDI vinculado + hallazgos.' })
  detail(
    @Query('source') source: string,
    @Query('ejercicio') ejercicio: string,
    @Query('periodo') periodo: string,
    @Query('tipo_pol') tipo_pol: string,
    @Query('folio') folio: string,
    @Query('sucursal') sucursal?: string,
  ) {
    return this.svc.detail({ source, ejercicio: Number(ejercicio), periodo: Number(periodo), tipo_pol, folio, sucursal });
  }

  @Post('scan')
  @RequirePermissions(Permission.FISCAL_CONTAB_GESTIONAR)
  @ApiOperation({ summary: 'Corre los detectores (incluye los de cuadre de pólizas) y refresca la bandeja de hallazgos.' })
  scan() {
    return this.detector.scanAll('polizas');
  }
}
