import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PaymentProgramService, PaymentProgramQuery } from './payment-program.service';

/**
 * Fase PP.2 — Programa de Pagos (Tesorería). Read-only sobre finance.payment_program.
 * Permiso FINANCE_PAYMENTS_VER (misma familia que "Pagos a proveedor" / "Cuadre y deuda").
 */
@ApiTags('finance-payment-program')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/payment-program')
export class PaymentProgramController {
  constructor(private readonly svc: PaymentProgramService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Lista pagos del programa (Tesorería) + KPIs + desglose banco/método. Filtros: month, bank, method, tipo, kepler(si|no|na), search.' })
  list(
    @Query('month') month?: string,
    @Query('bank') bank?: string,
    @Query('method') method?: string,
    @Query('tipo') tipo?: string,
    @Query('kepler') kepler?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const q: PaymentProgramQuery = { month, bank, method, tipo, kepler, search, limit: limit ? Number(limit) : undefined };
    return this.svc.list(q);
  }

  @Get('recon')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'PP.4 — conciliación por mes: control 3-vías (programa/Kepler-201/bancos-CB, universos distintos = informativo) + flag KEPLER de Tesorería (señal confiable de pagado-no-asentado).' })
  recon() {
    return this.svc.recon();
  }

  @Get('facets')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Facetas para filtros: meses, bancos, métodos, tipos.' })
  facets() {
    return this.svc.facets();
  }
}
