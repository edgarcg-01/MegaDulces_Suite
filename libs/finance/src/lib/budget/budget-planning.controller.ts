import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetPlanningService, CopyBudgetDto, ImportRow } from './budget-planning.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * Fase PU.4 — Presupuestos: planeación avanzada (ADR-066). Copiar ejercicio, comparar versiones,
 * importar partidas (preview + apply idempotente) y proyección de cierre.
 */
@ApiTags('finance-budget')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetPlanningController {
  constructor(private readonly svc: BudgetPlanningService) {}
  private who(req: AuthedRequest) { return req.user?.username || 'sistema'; }

  @Post('budgets/:id/copy')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Copia un ejercicio a un presupuesto nuevo en borrador, SIN arrastrar autorizaciones (buckets en cero).' })
  copy(@Param('id') id: string, @Body() dto: CopyBudgetDto, @Req() req: AuthedRequest) { return this.svc.copyBudget(id, dto ?? {}, this.who(req)); }

  @Get('compare')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Compara dos presupuestos línea a línea (versiones/escenarios).' })
  compare(@Query('a') a: string, @Query('b') b: string) { return this.svc.compareVersions(a, b); }

  @Post('budgets/:id/import/preview')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Muestra el impacto de una importación de partidas ANTES de aplicarla (create/update/errores).' })
  importPreview(@Param('id') id: string, @Body() body: { rows: ImportRow[] }) { return this.svc.importPreview(id, body?.rows ?? []); }

  @Post('budgets/:id/import/apply')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Aplica la importación. Idempotente por clave natural (reintentar NO duplica).' })
  importApply(@Param('id') id: string, @Body() body: { rows: ImportRow[] }, @Req() req: AuthedRequest) { return this.svc.importApply(id, body?.rows ?? [], this.who(req)); }

  @Get('budgets/:id/projection')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Proyección de cierre computada (firme y plena). No altera el presupuesto autorizado.' })
  projection(@Param('id') id: string) { return this.svc.projectionToClose(id); }
}
