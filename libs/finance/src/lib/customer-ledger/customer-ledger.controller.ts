import { Controller, Get, Post, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, TenantContextService } from '@megadulces/platform-core';
import { CustomerLedgerService, CarteraQuery } from './customer-ledger.service';
import { CustomerReceivablesScannerService } from './customer-receivables-scanner.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (CxC). Estado de cuenta
 * read-only sobre Kepler (kdue). Cartera + aging por cliente y auxiliar por cliente.
 */
@ApiTags('finance-customer-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/receivables')
export class CustomerLedgerController {
  constructor(
    private readonly svc: CustomerLedgerService,
    private readonly scanner: CustomerReceivablesScannerService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  @Post('scan-now')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Corre el detector de riesgo de cartera ahora (vencido / sobre-límite) → bandeja Maat.' })
  async scanNow() {
    const inserted = await this.scanner.scanTenant(this.tenantCtx.requireTenantId());
    return { inserted };
  }

  @Get()
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Cartera CxC por cliente: saldo + vencido + aging + KPIs.' })
  cartera(
    @Query('sucursal') sucursal?: string,
    @Query('cliente') cliente?: string,
    @Query('vendedor') vendedor?: string,
    @Query('grupo') grupo?: string,
    @Query('zona') zona?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('incluir_saldados') incluir_saldados?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: 'saldo' | 'vencido',
    @Query('limit') limit?: string,
  ) {
    const q: CarteraQuery = { sucursal, cliente, vendedor, grupo, zona, from, to, incluir_saldados, search, sort, limit: limit ? Number(limit) : undefined };
    return this.svc.cartera(q);
  }

  // Rutas de 1 segmento declaradas ANTES de ':sucursal/:cliente' (2 segmentos) — sin colisión.
  @Get('filtros')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Valores distintos para los selects (sucursal/grupo/zona/vendedor).' })
  filtros() { return this.svc.filtros(); }

  @Get('resumen')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Resumen gerencial: DSO, concentración top-10, proyección de cobranza, por vendedor/zona.' })
  resumen(@Query('sucursal') sucursal?: string, @Query('grupo') grupo?: string, @Query('zona') zona?: string) {
    return this.svc.resumen({ sucursal, grupo, zona });
  }

  @Get('tendencia')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Tendencia de cartera (snapshots diarios): saldo / vencido / % vencido.' })
  tendencia(@Query('sucursal') sucursal?: string, @Query('dias') dias?: string) {
    return this.svc.tendencia({ sucursal, dias: dias ? Number(dias) : undefined });
  }

  @Post('snapshot-now')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Captura el snapshot de cartera de hoy (para la tendencia).' })
  async snapshotNow() {
    const rows = await this.scanner.snapshotTenant(this.tenantCtx.requireTenantId());
    return { rows };
  }

  // Compromisos de pago (CXC.13). 'promise/:id/resolve' declarado antes que ':sucursal/:cliente'.
  @Post('promise/:id/resolve')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Resuelve un compromiso de pago: cumplida | incumplida | cancelada.' })
  resolvePromise(@Param('id') id: string, @Body('estado') estado: 'cumplida' | 'incumplida' | 'cancelada', @Req() req: AuthedRequest) {
    return this.svc.resolvePromise(id, estado, req.user?.username);
  }

  @Post(':sucursal/:cliente/promise')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Registra un compromiso de pago (promesa de cobro) del cliente.' })
  createPromise(
    @Param('sucursal') sucursal: string, @Param('cliente') cliente: string,
    @Body() body: { monto: number; fecha: string; nota?: string }, @Req() req: AuthedRequest,
  ) {
    return this.svc.createPromise(sucursal, cliente, body, req.user?.username);
  }

  @Get(':sucursal/:cliente')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Auxiliar de un cliente: partidas vivas con saldo por documento + aging + abonos + compromisos.' })
  detalle(@Param('sucursal') sucursal: string, @Param('cliente') cliente: string) {
    return this.svc.detalle(sucursal, cliente);
  }
}
