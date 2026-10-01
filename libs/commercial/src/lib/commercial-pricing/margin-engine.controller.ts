import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MarginEngineService } from './margin-engine.service';

/**
 * `[PR.V1]` — Los endpoints del motor de margen.
 *
 * ⛔ **UN solo permiso, y de lectura.** No hay `_GESTIONAR` porque no hay nada que gestionar:
 * Kepler es read-only (ADR-040) y el precio lo captura una persona allá. Mismo criterio que
 * `commercial-standard-cost`, que también nació sin `_GESTIONAR` por la misma razón.
 *
 * ⛔ Y **no reusa `COMMERCIAL_PRICING_VER`**, que parecía el natural. Medido en prod: lo tienen
 * **3 usuarios `customer_b2b` -que son CLIENTES-** más 35 de campo entre `promotor_ruta`,
 * `vendedor_ruta` y `repartidor`. Esta pantalla publica **costo, margen realizado y la fuga de
 * descuento de todo el catálogo**: copiarle el permiso se lo habría entregado a un cliente.
 */
@ApiTags('commercial-margin-engine')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/margin-engine')
export class MarginEngineController {
  constructor(private readonly svc: MarginEngineService) {}

  @Get('resumen')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'Qué se puede hacer hoy, cuánto vale y con qué certeza' })
  resumen() {
    return this.svc.resumen();
  }

  @Get('senales')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'Las 46 señales: las que el motor lee y las que NO, con su motivo' })
  senales() {
    return this.svc.senales();
  }

  @Get('cola')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'La cola priorizada por dinero' })
  cola(
    @Query('sucursal') sucursal?: string,
    @Query('accion') accion?: string,
    @Query('solo_libres') soloLibres?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.cola({
      sucursal: sucursal || undefined,
      accion: accion || undefined,
      soloLibres: soloLibres === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * ⭐⭐ El EXPEDIENTE: historia de costo y venta, los cambios de precio, qué pasó las veces
   * anteriores, el SKU en las 9 plazas y la demanda perdida. Un solo viaje — cinco llamadas
   * serían cinco estados de carga en la misma ventana.
   */
  @Get(':sucursal/:sku/expediente')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'El expediente completo del SKU: historia, eventos, plazas y faltantes' })
  expediente(@Param('sucursal') sucursal: string, @Param('sku') sku: string) {
    return this.svc.expediente(sucursal, sku);
  }

  /**
   * ⭐ El simulador. ⛔ **No escribe nada**: calcula el margen, el aterrizaje y el umbral de
   * equilibrio. Por eso sigue bastando `_VER` y no hace falta un `_GESTIONAR`.
   */
  @Get(':sucursal/:sku/simular')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'Simula un precio: margen, aterrizaje y umbral de equilibrio' })
  simular(
    @Param('sucursal') sucursal: string,
    @Param('sku') sku: string,
    @Query('precio') precio: string,
  ) {
    return this.svc.simular(sucursal, sku, Number(precio));
  }

  // ⚠️ Va DESPUÉS de las rutas fijas Y de las de dos segmentos: si fuera antes, `/expediente`
  //    entraría como un `:sku` y `/resumen` como un `:sucursal`.
  @Get(':sucursal/:sku')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'El plan de margen de un SKU: las 13 familias con su cobertura' })
  detalle(@Param('sucursal') sucursal: string, @Param('sku') sku: string) {
    return this.svc.detalle(sucursal, sku);
  }
}
