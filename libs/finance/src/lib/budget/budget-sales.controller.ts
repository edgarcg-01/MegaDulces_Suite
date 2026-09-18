import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetSalesPlanService, GenerateFromHistoryDto, UpsertSalesPlanLineDto } from './budget-sales-plan.service';
import { BudgetSalesComparisonService } from './budget-sales-comparison.service';

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
}
