import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  RouteProfitService, type PeriodoDisponible, type RentabilidadPeriodo,
} from './route-profit.service';

/**
 * `[RD.57]` — Rentabilidad de Ruta Directa. **Sólo lectura, a propósito:** acá no se corrige
 * nada. El costo se arregla en Kepler, el gasto en la contabilidad y la comisión en su propia
 * pantalla; un `GESTIONAR` sería una puerta a editar la cifra en vez de la causa (ADR-040).
 */
@ApiTags('commercial-route-profit')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/route-profit')
export class CommercialRouteProfitController {
  constructor(private readonly svc: RouteProfitService) {}

  /** Quincenas que tienen renglones para leer. */
  @Get('periods')
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_PROFIT_VER)
  periodos(): Promise<PeriodoDisponible[]> {
    return this.svc.periodos();
  }

  /** El tablero de una quincena. Sin `period_id` abre la última con renglones. */
  @Get()
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_PROFIT_VER)
  rentabilidad(@Query('period_id') periodId?: string): Promise<RentabilidadPeriodo> {
    return this.svc.rentabilidad(periodId);
  }
}
