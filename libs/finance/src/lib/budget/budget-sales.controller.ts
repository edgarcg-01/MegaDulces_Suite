import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetSalesPlanService, GenerateFromHistoryDto, UpsertSalesPlanLineDto, ProposePlanDto, UpsertSalesPlanSettingsDto } from './budget-sales-plan.service';
import { BudgetSalesComparisonService } from './budget-sales-comparison.service';
import { BudgetSalesIndicatorsService } from './budget-sales-indicators.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * Fase PV — Presupuesto de Ventas (ADR-066 / PV). Plan (meta por entidad×periodo 13×4) +
 * comparación meta vs real + CREC + PART. Reusa `PRESUPUESTOS_VER/GESTIONAR` (misma familia que
 * el resto de Presupuestos). El real sale de vistas sobre el ODS (cero importer).
 */
@ApiTags('finance-budget-sales')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetSalesController {
  constructor(
    private readonly plan: BudgetSalesPlanService,
    private readonly comparison: BudgetSalesComparisonService,
    private readonly indicators: BudgetSalesIndicatorsService,
  ) {}

  private who(req: AuthedRequest) { return req.user?.username || 'sistema'; }

  @Get('sales-entities')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Catálogo de entidades de venta (sucursal×canal + ruta).' })
  entities() { return this.plan.getEntities(); }

  @Get('budgets/:id/sales-plan')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  getPlan(@Param('id') id: string) { return this.plan.getPlan(id); }

  @Post('budgets/:id/sales-plan/generate')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Genera la meta = real año anterior × (1+growth). Sin base histórica no crea fila.' })
  generate(@Param('id') id: string, @Body() dto: GenerateFromHistoryDto, @Req() req: AuthedRequest) {
    return this.plan.generateFromHistory(id, dto, this.who(req));
  }

  @Post('budgets/:id/sales-plan/line')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Captura/override manual de una celda entidad × periodo.' })
  upsertLine(@Param('id') id: string, @Body() dto: UpsertSalesPlanLineDto, @Req() req: AuthedRequest) {
    return this.plan.upsertLine(id, dto, this.who(req));
  }

  @Delete('budgets/:id/sales-plan/line')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  deleteLine(@Param('id') id: string, @Query('entity_key') entityKey: string, @Query('period_no') periodNo: string) {
    return this.plan.deleteLine(id, entityKey, Number(periodNo));
  }

  @Get('budgets/:id/sales-comparison')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Pivote meta vs real + CREC (YoY) + PART (participación) por entidad × periodo 13×4.' })
  getComparison(@Param('id') id: string) { return this.comparison.getComparison(id); }

  // ── PVA — Automatización (el sistema propone, el humano ajusta) ──

  @Get('budgets/:id/sales-plan/settings')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Supuestos anuales del plan de ventas (crecimiento por canal, método).' })
  getSettings(@Param('id') id: string) { return this.plan.getSettings(id); }

  @Put('budgets/:id/sales-plan/settings')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Fija/ajusta los supuestos anuales (la única perilla del humano).' })
  upsertSettings(@Param('id') id: string, @Body() dto: UpsertSalesPlanSettingsDto, @Req() req: AuthedRequest) {
    return this.plan.upsertSettings(id, dto, this.who(req));
  }

  @Get('budgets/:id/sales-plan/propose-growth')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Propone el crecimiento por canal desde la tendencia histórica (con cobertura declarada).' })
  proposeGrowth(@Param('id') id: string) { return this.plan.proposeGrowth(id); }

  @Post('budgets/:id/sales-plan/propose')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Propone el plan COMPLETO (relleno híbrido: base×crec + PART/estacionalidad). Devuelve cobertura.' })
  propose(@Param('id') id: string, @Body() dto: ProposePlanDto, @Req() req: AuthedRequest) {
    return this.plan.proposePlan(id, dto, this.who(req));
  }

  @Get('budgets/:id/sales-indicators')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Tablero de indicadores: CREC/PART por canal/entidad × año (histórico) + meta-vs-real.' })
  getIndicators(@Param('id') id: string) { return this.indicators.getIndicators(id); }
}
