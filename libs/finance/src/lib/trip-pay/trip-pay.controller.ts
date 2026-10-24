import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission } from '@megadulces/platform-core';
import { CorteDeLogistica, DetallePersona, TripPayService, ValeCreado } from './trip-pay.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * `[EMB.29]` — Corte de comisiones y viáticos de logística (ADR-091). Lo prepara Logística
 * (`LOGISTICS_SHIPMENTS_GESTIONAR`) y lo aprueba Finanzas en «Aprobación de gastos»
 * (`FINANCE_EXPENSES_COMPROBAR`); nadie aprueba lo que preparó.
 * `[EMB.43]` Logística › Pagos de viaje entra con su permiso propio: ver la catorcena con
 * `LOGISTICS_PAGOS_VER` y armar el vale con `LOGISTICS_PAGOS_GESTIONAR`.
 * ⛔ No se abre a `FINANCE_EXPENSES_CAPTURAR`: lo tiene casi todo el que captura un gasto, y
 *    armar el vale de logística no es su tarea.
 */
@ApiTags('finance-trip-pay')
@Controller('finance/trip-pay')
export class TripPayController {
  constructor(private readonly svc: TripPayService) {}

  @Get('corte')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_COMPROBAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.LOGISTICS_PAGOS_VER)
  @ApiOperation({ summary: 'EMB.29: por persona, lo liberado (viajes cerrados y cargas), lo retenido y lo ya en vale del corte de 14 días' })
  corte(@Query('desde') desde?: string, @Query('hasta') hasta?: string): Promise<CorteDeLogistica> {
    return this.svc.corte(desde, hasta);
  }

  @Get('personas/:driverId')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_COMPROBAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.LOGISTICS_PAGOS_VER)
  @ApiOperation({ summary: 'EMB.29: el detalle de una persona en el corte, viaje por viaje' })
  persona(@Param('driverId') driverId: string, @Query('desde') desde?: string, @Query('hasta') hasta?: string): Promise<DetallePersona> {
    return this.svc.persona(driverId, desde, hasta);
  }

  @Post('vales')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_COMPROBAR, Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.LOGISTICS_PAGOS_GESTIONAR)
  @ApiOperation({ summary: 'EMB.29: arma el vale de Gastos de una persona con sus viajes y cargas liberados' })
  crearVale(
    @Body() body: { driver_id?: string; desde?: string; hasta?: string },
    @Req() req: AuthedRequest,
  ): Promise<ValeCreado> {
    const actor = req?.user?.full_name || req?.user?.username || '';
    return this.svc.crearVale(body?.driver_id || '', body?.desde, body?.hasta, actor);
  }
}
