import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  RouteProfitService, type PeriodoDisponible, type RentabilidadPeriodo, type SeriePeriodo,
  type GastoDetalle, type FlotaResumen,
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

  /**
   * `[RD.58]` La serie del año y la tendencia por ruta: quién viene empeorando.
   * Sin `anio` toma el corriente.
   */
  @Get('series')
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_PROFIT_VER)
  serie(@Query('anio') anio?: string): Promise<SeriePeriodo> {
    return this.svc.serie(anio ? Number(anio) : undefined);
  }

  /**
   * `[RD.60]` El gasto de la quincena **renglón por renglón** — lo que el tablero muestra
   * agregado. ⚠️ Va ANTES del `@Get()` raíz: una ruta con segmento literal declarada después
   * la toma el comodín.
   */
  @Get('expenses')
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_PROFIT_VER)
  gastoDetalle(
    @Query('anio') anio: string,
    @Query('period_no') periodNo: string,
  ): Promise<GastoDetalle> {
    const hoy = new Date();
    return this.svc.gastoDetalle(
      anio ? Number(anio) : hoy.getFullYear(),
      periodNo ? Number(periodNo) : 1,
    );
  }

  /** `[RD.60]` La flota de Ruta Directa: lo que se sabe de cada camioneta, y lo que no. */
  @Get('fleet')
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_PROFIT_VER)
  flota(): Promise<FlotaResumen> {
    return this.svc.flota();
  }

  /** El tablero de una quincena. Sin `period_id` abre la última con renglones. */
  @Get()
  @RequirePermissions(Permission.COMMERCIAL_ROUTE_PROFIT_VER)
  rentabilidad(@Query('period_id') periodId?: string): Promise<RentabilidadPeriodo> {
    return this.svc.rentabilidad(periodId);
  }
}
