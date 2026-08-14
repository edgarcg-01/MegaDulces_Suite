import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CajaGeneralService, CajaQuery } from './caja-general.service';

interface AuthedRequest { user?: { username?: string } }

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

  @Get('general')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'CAJA GENERAL viva (Doctos): ingresos/gastos por cuenta + KPIs + por-mes + movimientos. Filtros: month|from/to, tipo(Ingreso|Gasto), search.' })
  general(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('tipo') tipo?: string, @Query('search') search?: string) {
    return this.svc.general(this.q(month, from, to, undefined, undefined, undefined, tipo, search));
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

  @Get('conciliacion-detalle')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Conciliación de ingresos a nivel movimiento: depósito Caja ↔ ingreso banco (matched / caja sin banco = fuga / banco sin caja = cobranza). Filtro banco opcional.' })
  conciliacionDetalle(@Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('instance') instance?: string, @Query('banco') banco?: string) {
    return this.svc.conciliacionDetalle(this.q(month, from, to, instance, banco));
  }

  @Get('facets')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Facetas para filtros: meses, bancos, empresas, cajas.' })
  facets() {
    return this.svc.facets();
  }

  @Get('crosswalk')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Enlace de cuentas Caja→banco: estado actual + sugerencia vía Kepler (match depósitos monto+fecha) + alternativas.' })
  crosswalk() {
    return this.svc.crosswalk();
  }

  @Post('crosswalk')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Confirma/edita el enlace de una cuenta de Caja a su account_label (CB/Kepler). label vacío = desenlazar.' })
  crosswalkSet(@Body() body: { banco_code: string; account_label?: string | null; matches?: number }, @Req() req: AuthedRequest) {
    return this.svc.crosswalkSet(body.banco_code, body.account_label ?? null, Number(body.matches) || 0, req.user?.username);
  }
}
