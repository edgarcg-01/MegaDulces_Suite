import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CajaGeneralService, CajaQuery } from './caja-general.service';

/**
 * Fase CG.3 — Caja General (Tesorería). Read-only sobre analytics.caja_*.
 * Permiso FINANCE_BANK_VER (misma persona que Bancos/CB — la caja general concilia
 * contra el estado de cuenta bancario).
 */
@ApiTags('finance-caja')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/caja')
export class CajaGeneralController {
  constructor(private readonly svc: CajaGeneralService) {}

  private q(month?: string, from?: string, to?: string, instance?: string, banco?: string, almacen?: string, tipo?: string, search?: string, limit?: string): CajaQuery {
    return { month, from, to, instance, banco, almacen, tipo, search, limit: limit ? Number(limit) : undefined };
  }

  @Get('overview')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'KPIs del periodo: venta vs depositado por forma de pago + descuadre. Filtros: month|from/to, instance(SI|NO).' })
  overview(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('instance') instance?: string) {
    return this.svc.overview(this.q(month, from, to, instance));
  }

  @Get('por-sucursal')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Venta vs depositado por sucursal + descuadre + % depositado.' })
  porSucursal(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('instance') instance?: string) {
    return this.svc.porSucursal(this.q(month, from, to, instance));
  }

  @Get('depositos')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Ledger de depósitos + KPIs + desglose por banco. Filtros: month|from/to, banco, almacen, search.' })
  depositos(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('instance') instance?: string, @Query('banco') banco?: string, @Query('almacen') almacen?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.depositos({ month, from, to, instance, banco, almacen, search, limit: limit ? Number(limit) : undefined });
  }

  @Get('arqueos')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Arqueos de caja (conteo por denominación). Filtros: month|from/to, tipo, almacen(=caja), search.' })
  arqueos(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('tipo') tipo?: string, @Query('almacen') almacen?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.arqueos({ month, from, to, tipo, almacen, search, limit: limit ? Number(limit) : undefined });
  }

  @Get('conciliacion')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Depósitos de caja ↔ ingresos del banco (CB) por banco. Delta informativo (universos distintos); cuadre por totales ±$1,000.' })
  conciliacion(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('instance') instance?: string) {
    return this.svc.conciliacion(this.q(month, from, to, instance));
  }

  @Get('facets')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Facetas para filtros: meses, bancos, empresas, cajas.' })
  facets() {
    return this.svc.facets();
  }
}
