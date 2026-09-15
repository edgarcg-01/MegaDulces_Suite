import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetExpenseObligationsService, CreateExpenseObligationDto } from './budget-expense-obligations.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/** Fase TP.1 — Presupuestos: gastos autorizados (ADR-064). Alimenta el Calendario de Pagos. */
@ApiTags('finance-budget-expense-obligations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget/expenses')
export class BudgetExpenseObligationsController {
  constructor(private readonly svc: BudgetExpenseObligationsService) {}

  @Get()
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  list(@Query('status') status?: string, @Query('search') search?: string, @Query('dueFrom') dueFrom?: string, @Query('dueTo') dueTo?: string) {
    return this.svc.list({ status, search, dueFrom, dueTo });
  }

  @Get(':id')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Captura un gasto autorizado. Nace autorizado (authorized_by = quien lo captura).' })
  create(@Body() dto: CreateExpenseObligationDto, @Req() req: AuthedRequest) {
    return this.svc.create(dto, req.user?.username || 'sistema');
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.cancel(id, body?.reason, req.user?.username || 'sistema');
  }
}
