import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import type { CausaNegativo, EstadoNegativo, ExistenciaNegativaResponse, KardexNegativoResponse, ResolucionNegativo } from '@megadulces/contracts';
import { NegativeStockService } from './negative-stock.service';

/**
 * `[MX.2.8]` — Existencia en negativo, la sección de Prevención en `/almacen/incidencias`.
 *
 * Controlador APARTE del de movimientos a propósito: no se toca la firma inyectada de uno que ya
 * está en producción (#414). Mismos permisos que la bandeja de incidencias: ver con
 * `COMMERCIAL_MOVEMENTS_VER` (el encargado de tienda lo tiene, y el servicio lo acota a su sucursal,
 * D10); resolver con `COMMERCIAL_MOVEMENTS_GESTIONAR` (Prevención). Medido en prod el 2026-11-03:
 * los dos ya están repartidos, no hace falta permiso nuevo.
 */
@ApiTags('commercial-movements')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/movements/negative-stock')
export class NegativeStockController {
  constructor(private readonly svc: NegativeStockService) {}

  @Get()
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: '[MX.2.8] Producto × sucursal con existencia NEGATIVA en Kepler, con su causa si el dato la prueba (vale sin orden de entrada), valor a costo y resolución. Totales sobre todo el alcance. Filtros: warehouse_ids, estado (pendientes|resueltas), causas (entrada_sin_aplicar,salio_sin_existencia,rezago; vacío = las activas), search, page, pageSize.' })
  list(@Query() raw: Record<string, string | undefined>): Promise<ExistenciaNegativaResponse> {
    const lista = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return this.svc.list({
      warehouse_ids: lista(raw.warehouse_ids ?? raw.warehouse_id),
      estado: raw.estado as EstadoNegativo | undefined,
      causas: lista(raw.causas) as CausaNegativo[],
      search: raw.search,
      page: raw.page ? Number(raw.page) : undefined,
      pageSize: raw.pageSize ? Number(raw.pageSize) : undefined,
    });
  }

  @Get('kardex')
  @RequireAnyPermission(Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: '[MX.2.9] Kardex de UN producto en UNA sucursal desde kdm2 en vivo: saldo corrido, día en que cruzó a negativo, lo que salió desde entonces por documento/caja y pistas (unidad desentonada, entrada tardía, último conteo). Declara si el kardex no cuadra con Kepler. Query: warehouse_id, sku.' })
  kardex(@Query('warehouse_id') warehouse_id?: string, @Query('sku') sku?: string): Promise<KardexNegativoResponse> {
    return this.svc.kardex({ warehouse_id, sku });
  }

  @Post('resolve')
  @RequirePermissions(Permission.COMMERCIAL_MOVEMENTS_GESTIONAR)
  @ApiOperation({ summary: '[MX.2.8] Resuelve una existencia negativa con su motivo (catálogo MOTIVOS_EXISTENCIA_NEGATIVA). Guarda la existencia de HOY en Kepler (no la del payload). Body: { warehouse_id, sku, motivo, nota? }.' })
  resolve(@Body() dto: { warehouse_id: string; sku: string; motivo: string; nota?: string | null }): Promise<ResolucionNegativo> {
    return this.svc.resolve(dto);
  }

  @Post('reopen')
  @RequirePermissions(Permission.COMMERCIAL_MOVEMENTS_GESTIONAR)
  @ApiOperation({ summary: '[MX.2.8] Reabre una existencia negativa resuelta. Body: { warehouse_id, sku }.' })
  reopen(@Body() dto: { warehouse_id: string; sku: string }): Promise<{ reabierta: boolean }> {
    return this.svc.reopen(dto);
  }
}
