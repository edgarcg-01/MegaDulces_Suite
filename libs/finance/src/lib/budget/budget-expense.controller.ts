import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  BudgetExpensePlanService, ProposeExpensePlanDto, UpsertExpensePlanSettingsDto, UpsertExpensePlanLineDto,
} from './budget-expense-plan.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * Fase PVG — Presupuesto de GASTOS auto-propuesto desde egresos de Kepler (ADR-073). El sistema propone
 * (crecimiento del histórico + relleno híbrido por cuenta mayor × mes); el humano ajusta. Reusa
 * `PRESUPUESTOS_VER/GESTIONAR`. Cero importer: el real/base sale de `analytics.expense_entries`.
 */
@ApiTags('finance-budget-expense')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget')
export class BudgetExpenseController {
  constructor(private readonly plan: BudgetExpensePlanService) {}

  private who(req: AuthedRequest) { return req.user?.username || 'sistema'; }

  @Get('budgets/:id/expense-plan')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Plan de gastos propuesto (cuenta mayor × sucursal × mes) + supuestos.' })
  getPlan(@Param('id') id: string) { return this.plan.getPlan(id); }

  @Get('budgets/:id/expense-plan/settings')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Supuestos del presupuesto de gastos (familias, crecimiento por cuenta, por sucursal).' })
  getSettings(@Param('id') id: string) { return this.plan.getSettings(id); }

  @Put('budgets/:id/expense-plan/settings')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Fija/ajusta los supuestos del presupuesto de gastos (las perillas del humano).' })
  upsertSettings(@Param('id') id: string, @Body() dto: UpsertExpensePlanSettingsDto, @Req() req: AuthedRequest) {
    return this.plan.upsertSettings(id, dto, this.who(req));
  }

  @Get('budgets/:id/expense-plan/propose-growth')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Propone el crecimiento por cuenta mayor desde la tendencia de egresos (cobertura declarada).' })
  proposeGrowth(@Param('id') id: string) { return this.plan.proposeExpenseGrowth(id); }

  @Post('budgets/:id/expense-plan/propose')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Propone el plan de gastos COMPLETO (cuenta × mes: base×crec + relleno recurrente). Devuelve cobertura.' })
  propose(@Param('id') id: string, @Body() dto: ProposeExpensePlanDto, @Req() req: AuthedRequest) {
    return this.plan.proposeExpensePlan(id, dto, this.who(req));
  }

  @Post('budgets/:id/expense-plan/line')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Captura/override manual de una celda cuenta × sucursal × mes.' })
  upsertLine(@Param('id') id: string, @Body() dto: UpsertExpensePlanLineDto, @Req() req: AuthedRequest) {
    return this.plan.upsertLine(id, dto, this.who(req));
  }

  @Delete('budgets/:id/expense-plan/line')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  deleteLine(
    @Param('id') id: string,
    @Query('account_code') accountCode: string,
    @Query('sucursal') sucursal: string,
    @Query('year_month') yearMonth: string,
  ) {
    return this.plan.deleteLine(id, accountCode, sucursal || '', yearMonth);
  }
}
