import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ProntoPagoService, EstadoPronto } from './pronto-pago.service';

/**
 * `[PP.1]` — Pronto pago: lo que Tesorería todavía puede ganar, y hasta cuándo. Sólo lectura.
 *
 * ⚠️ Reusa `FINANCE_PAYMENTS_VER` a propósito: es la misma familia que Pagos a proveedor y
 * Comprobantes, y es la gente que decide a quién se le paga hoy. Un permiso nuevo obligaría a
 * repartirlo otra vez y dejaría la pantalla invisible mientras tanto — que es exactamente cómo
 * el módulo de Libro de Compras estuvo en prod sin que nadie pudiera abrirlo (`[LC.6.2]`).
 */
@ApiTags('finance-pronto-pago')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/pronto-pago')
export class ProntoPagoController {
  constructor(private readonly svc: ProntoPagoService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({
    summary: 'PP.1 — Facturas de mercancia pendientes con descuento por pronto pago OBSERVADO: '
           + 'cuanto se puede ganar todavia, cuanto esta por vencer y cuanto quedo fuera de la '
           + 'ventana. Incluye lo ya perdido (finance.findings/descuento_no_capturado). '
           + 'Filtros: estado (capturable|por_vencer|fuera_de_ventana|sin_medir), search, limit.',
  })
  overview(
    @Query('estado') estado?: EstadoPronto,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.overview({ estado, search, limit: limit ? Number(limit) : undefined });
  }
}
