import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * RD.6 — Comisiones de Ruta Directa.
 *
 * VER y GESTIONAR son permisos propios, no colgados de `COMMERCIAL_ROUTE_SALES_VER`: ver
 * cuánto vendió una ruta y ver cuánto cobra su chofer son cosas distintas, y lo segundo es
 * nómina. Se reparten en la migración `20260908120200`, porque un permiso declarado en el
 * enum y no repartido deja el módulo inaccesible para todos salvo `ALL_PERMS` — pasó con
 * `FISCAL_PURCHASE_BOOK_*` en LC.6.2.
 */
@ApiTags('commercial-commissions')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/commissions')
export class CommercialCommissionsController {
  constructor(private readonly service: CommercialCommissionsService) {}

  @Get('periods')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Quincenas del año, cada una con su corrida viva si la tiene',
    description: 'Query: `anio` (opcional, default todas). Cada periodo trae `run` = { run_id, status, total_a_pagar, rutas_sin_dato } o null.',
  })
  periods(@Query('anio') anio?: string) {
    return this.service.listPeriods(anio ? Number(anio) : undefined);
  }

  @Get('scale')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'La escala vigente a una fecha',
    description: 'Query: `on` (YYYY-MM-DD, default hoy). El tabulador vive en la DB: cambiarlo es un INSERT con valid_from, no un deploy.',
  })
  scale(@Query('on') on?: string) {
    return this.service.getScale(on || new Date().toISOString().slice(0, 10));
  }

  @Post('preview')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Calcula el periodo SIN persistir, para cuadrarlo antes de crear la corrida',
    description: 'Body: `{ period_id }`. Devuelve el mismo payload que /compute pero con `run_id: null`.',
  })
  preview(@Body() body: { period_id: string }) {
    return this.service.computeRun(body?.period_id, { dryRun: true });
  }

  @Post('compute')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Crea la corrida del periodo en estado borrador',
    description: 'Body: `{ period_id, replace? }`. Un periodo tiene UNA corrida viva; `replace` sólo funciona si está en borrador.',
  })
  compute(@Body() body: { period_id: string; replace?: boolean }) {
    return this.service.computeRun(body?.period_id, { replace: body?.replace === true });
  }

  @Get('runs/:id')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({ summary: 'La corrida con su detalle por ruta y beneficiario' })
  run(@Param('id') id: string) {
    return this.service.getRun(id);
  }

  @Post('runs/:id/approve')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({ summary: 'borrador → aprobado. El motor calcula; aprobar es humano (ADR-016)' })
  approve(@Param('id') id: string) {
    return this.service.setStatus(id, 'aprobado');
  }

  @Post('runs/:id/pay')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({ summary: 'aprobado → pagado. No se salta el paso de aprobación' })
  pay(@Param('id') id: string) {
    return this.service.setStatus(id, 'pagado');
  }

  @Post('runs/:id/void')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({ summary: 'Anula la corrida. Una pagada no se anula: queda como está' })
  voidRun(@Param('id') id: string) {
    return this.service.setStatus(id, 'anulado');
  }
}
