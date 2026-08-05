import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PagosControlService } from './pagos-control.service';

/** CXP.2 — Tablero maestro de Cuentas por Pagar / Tesorería (solo lectura). */
@ApiTags('finance-pagos')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/pagos')
export class PagosControlController {
  constructor(private readonly svc: PagosControlService) {}

  @Get('control')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'CXP.2 — Resumen CxP: fuga de descuento, riesgo doble pago, facturas duplicadas, DPO, acciones HITL y reconciliación de descuentos.' })
  overview() { return this.svc.overview(); }

  @Get('conciliacion')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'CXP.5 — Conciliación de pagos a proveedor mes a mes: Kepler (erp_supplier_payments) vs Banco (CB egresos compra/factoraje) + Δ + estado. Cuadre AGREGADO (no por proveedor). Filtros: from_mes, to_mes (YYYY-MM).' })
  conciliacion(@Query('from_mes') from_mes?: string, @Query('to_mes') to_mes?: string) {
    return this.svc.conciliacion({ from_mes, to_mes });
  }
}
