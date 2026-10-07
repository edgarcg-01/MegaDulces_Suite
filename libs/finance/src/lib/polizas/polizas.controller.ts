import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, SkipTenantTx } from '@megadulces/platform-core';
import { PolizasService } from './polizas.service';
import { PolizaTypeAuditService } from './poliza-type-audit.service';
import { PolizaTypeFindingsBridgeService } from './poliza-type-findings-bridge.service';
import { MaatDetectorService } from '../maat/maat-detector.service';
import { FinanceJobsService } from '../jobs/finance-jobs.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/** `?sync=true` (o `sync: true` en el body) fuerza el camino inline: CLI y smokes. */
function wantsInline(q?: string, b?: boolean): boolean {
  return b === true || q === 'true' || q === '1';
}

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
    private readonly tipos: PolizaTypeAuditService,
    private readonly tiposBridge: PolizaTypeFindingsBridgeService,
    private readonly detector: MaatDetectorService,
    private readonly jobs: FinanceJobsService,
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

  /* ---- PV.4: auditor del TIPO de poliza (D/E/I) ---- */

  @Get('tipos/summary')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiQuery({ name: 'anio', required: false, description: 'Ventana para medir el uso de cada doctype. Default: ano en curso.' })
  @ApiOperation({ summary: 'Cabecera del auditor de tipo de poliza. Cada bloque trae su estado de medicion (ADR-056: lo que no se midio se declara, no se dibuja como cero).' })
  tiposSummary(@Query('anio') anio?: string) {
    return this.tipos.summary(anio ? Number(anio) : undefined);
  }

  @Get('tipos/catalogo')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiQuery({ name: 'anio', required: false })
  @ApiOperation({ summary: 'Doctypes de Kepler cuyo tipo de poliza no concuerda con las cuentas que mueve, con su volumen del ano (separa incongruencia viva de catalogo dormido).' })
  tiposCatalogo(@Query('anio') anio?: string) {
    return this.tipos.catalogAudit(anio ? Number(anio) : undefined);
  }

  @Get('tipos/cruce')
  @RequirePermissions(Permission.FISCAL_CONTAB_VER)
  @ApiQuery({ name: 'meses', required: false, description: 'Ventana en meses (1-36). Default 6.' })
  @ApiOperation({ summary: 'Brecha de clasificacion por tipo de poliza y mes entre Kepler y ContPAQi. Sin una de las dos fuentes devuelve not_measured con motivo, nunca una lista vacia.' })
  tiposCruce(@Query('meses') meses?: string) {
    return this.tipos.crossAudit(meses ? Number(meses) : 6);
  }

  @Post('tipos/sync')
  @RequirePermissions(Permission.FISCAL_CONTAB_GESTIONAR)
  @ApiOperation({ summary: 'Empuja los hallazgos de tipo de poliza a la bandeja de Maat y avisa por la campana. Idempotente (UPSERT por dedup_key).' })
  tiposSync() {
    return this.tiposBridge.syncCurrent();
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
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'Corre los detectores (incluye los de cuadre de pólizas) y refresca la bandeja de hallazgos. Async: 202 + job_id, resultado por WS `finance_job`.' })
  scan(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (wantsInline(sync, body?.sync)) return this.detector.scanAll('polizas');
    // Mismo `name` que el scan de la bandeja de hallazgos a propósito: es el MISMO
    // trabajo (los 10 detectores) disparado desde otra pantalla, y el registro de
    // jobs no debería mostrarlo como dos cosas distintas.
    res.status(202);
    return this.jobs.run({
      name: 'maat-scan',
      label: 'Detectores (desde pólizas)',
      actor: req?.user?.full_name || req?.user?.username || null,
      exec: () => this.detector.scanAll('polizas'),
    });
  }
}
