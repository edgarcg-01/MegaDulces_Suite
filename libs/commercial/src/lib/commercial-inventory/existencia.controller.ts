import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ExistenciaService, ExistenciaQuery } from './existencia.service';

/**
 * EXISTENCIA — la matriz producto × almacén. Sirve a DOS proyectos del sidebar
 * (`/almacen/inventory/existencia` y `/compras/existencia`) con **un solo permiso**, calcando el
 * precedente de Caducidades. Por eso NO hace falta `@RequireAnyPermission`: los dos lados ven los
 * mismos números, así que un permiso alcanza y le ahorra al admin acordarse de dar dos.
 *
 * ⚠️ Todo el trabajo va dentro de `TenantKnexService.run()` (lo hace el servicio): las dos vistas
 * que lee son `security_invoker`, así que sin el GUC del tenant devuelven vacío — o peor, cruzado.
 */
@ApiTags('commercial-existencia')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory/existencia')
export class ExistenciaController {
  constructor(private readonly service: ExistenciaService) {}

  @Get()
  @RequirePermissions(Permission.EXISTENCIA_VER)
  @ApiOperation({ summary: 'Matriz de existencia producto × almacén (en vivo desde el ODS)' })
  list(@Query() q: ExistenciaQuery) {
    return this.service.list(q);
  }

  /**
   * El export pide `_GESTIONAR` y no `_VER`: es el dataset COMPLETO de la red valuado a costo,
   * o sea un privilegio distinto de mirar la pantalla. Mismo criterio que la bitácora de
   * movimientos, que se gatea con AJUSTAR y no con VER (commercial-inventory.controller.ts).
   */
  @Get('export')
  @RequirePermissions(Permission.EXISTENCIA_GESTIONAR)
  @ApiOperation({ summary: 'Dataset completo de existencia valuado (sin paginar)' })
  export(@Query() q: ExistenciaQuery) {
    return this.service.list({ ...q, export: true });
  }

  // ⚠️ Va DESPUÉS de 'export': si fuera antes, la ruta ':productId' se comería esa palabra.
  @Get(':productId')
  @RequirePermissions(Permission.EXISTENCIA_VER)
  @ApiOperation({ summary: 'Desglose de un SKU por almacén, con la escalera de unidad' })
  detail(@Param('productId') productId: string) {
    return this.service.detail(productId);
  }
}
