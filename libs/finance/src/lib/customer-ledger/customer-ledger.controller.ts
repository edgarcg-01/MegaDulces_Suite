import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CustomerLedgerService, CarteraQuery } from './customer-ledger.service';

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (CxC). Estado de cuenta
 * read-only sobre Kepler (kdue). Cartera + aging por cliente y auxiliar por cliente.
 */
@ApiTags('finance-customer-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/receivables')
export class CustomerLedgerController {
  constructor(private readonly svc: CustomerLedgerService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Cartera CxC por cliente: saldo + vencido + aging + KPIs.' })
  cartera(
    @Query('sucursal') sucursal?: string,
    @Query('cliente') cliente?: string,
    @Query('vendedor') vendedor?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('incluir_saldados') incluir_saldados?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const q: CarteraQuery = { sucursal, cliente, vendedor, from, to, incluir_saldados, search, limit: limit ? Number(limit) : undefined };
    return this.svc.cartera(q);
  }

  @Get(':sucursal/:cliente')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: 'Auxiliar de un cliente: partidas vivas con saldo por documento + aging + abonos.' })
  detalle(@Param('sucursal') sucursal: string, @Param('cliente') cliente: string) {
    return this.svc.detalle(sucursal, cliente);
  }
}
