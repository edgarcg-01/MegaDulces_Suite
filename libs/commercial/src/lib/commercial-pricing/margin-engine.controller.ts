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

  // ⚠️ Va DESPUÉS de las rutas fijas: si fuera antes, `/resumen` entraría como `:sucursal`.
  @Get(':sucursal/:sku')
  @RequirePermissions(Permission.COMMERCIAL_MARGIN_ENGINE_VER)
  @ApiOperation({ summary: 'El plan de margen de un SKU: las 13 familias con su cobertura' })
  detalle(@Param('sucursal') sucursal: string, @Param('sku') sku: string) {
    return this.svc.detalle(sucursal, sku);
  }
}
