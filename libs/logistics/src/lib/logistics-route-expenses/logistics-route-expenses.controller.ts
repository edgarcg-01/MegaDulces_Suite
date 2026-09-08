import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { LogisticsRouteExpensesService, RouteExpenseDto } from './logistics-route-expenses.service';

/** RD.4 — gasto de flota de Ruta Directa. Ver el header del service. */
@ApiTags('logistics-route-expenses')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('logistics/route-expenses')
export class LogisticsRouteExpensesController {
  constructor(private readonly service: LogisticsRouteExpensesService) {}

  @Get('types')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_VER)
  @ApiOperation({ summary: 'El catálogo de tipos de gasto (incluye 0 SIN CLASIFICAR)' })
  types() { return this.service.types(); }

  @Get()
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_VER)
  @ApiOperation({
    summary: 'Lista de gastos con sus totales',
    description: 'Query: from, to, route_code, expense_type, sin_clasificar, limit, offset. Devuelve `sin_clasificar` aparte: el tipo no se adivina, y si quedan filas sin clasificar el resumen por tipo está incompleto a propósito.',
  })
  list(@Query() q: Record<string, string>) {
    return this.service.list({
      from: q.from, to: q.to, route_code: q.route_code,
      expense_type: q.expense_type !== undefined ? Number(q.expense_type) : undefined,
      sin_clasificar: q.sin_clasificar === 'true',
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  }

  @Get('summary')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_VER)
  @ApiOperation({ summary: 'Resumen ruta × tipo del periodo, con litros y $/litro. Query: from, to (obligatorios)' })
  summary(@Query('from') from: string, @Query('to') to: string) {
    return this.service.summary(from, to);
  }

  @Post()
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR)
  @ApiOperation({ summary: 'Captura un gasto' })
  create(@Body() dto: RouteExpenseDto) { return this.service.create(dto); }

  @Patch(':id')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR)
  @ApiOperation({ summary: 'Corrige un gasto (acá se reclasifican los SIN CLASIFICAR)' })
  update(@Param('id') id: string, @Body() dto: Partial<RouteExpenseDto>) { return this.service.update(id, dto); }

  @Delete(':id')
  @RequirePermissions(Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete' })
  remove(@Param('id') id: string) { return this.service.remove(id); }
}
