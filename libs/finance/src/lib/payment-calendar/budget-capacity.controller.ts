import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetCapacityService } from './budget-capacity.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/** Fase TP.1 — Presupuestos: capacidad de pago por fecha (ADR-064). Permiso propio PRESUPUESTOS_*. */
@ApiTags('finance-budget-capacity')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget/capacity')
export class BudgetCapacityController {
  constructor(private readonly svc: BudgetCapacityService) {}

  @Get()
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Capacidad de un día (date=YYYY-MM-DD) o un rango (from/to).' })
  get(@Query('date') date?: string, @Query('from') from?: string, @Query('to') to?: string) {
    if (date) return this.svc.getForDate(date);
    if (from && to) return this.svc.listRange(from, to);
    throw new BadRequestException('Se requiere date, o from+to');
  }

  @Get('history')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  history(@Query('date') date: string) {
    return this.svc.history(date);
  }

  @Post()
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Fija/edita la capacidad autorizada de un día. Siempre queda en el historial.' })
  set(@Body() body: { date: string; amount: number; reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.setForDate(body.date, Number(body.amount), body.reason, req.user?.username || 'sistema');
  }
}
