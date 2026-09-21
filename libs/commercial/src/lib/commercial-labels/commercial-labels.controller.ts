import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialLabelsService } from './commercial-labels.service';

/**
 * Etiquetera (proyecto Tienda). Ruta bajo /store/* para mantener Tienda cohesivo,
 * aunque el código viva en libs/commercial (donde ya está wireado TenantKnexService/RLS).
 * Gateado con STORE_LIVE_VER (mismo permiso del proyecto Tienda).
 */
@ApiTags('store-labels')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('store/labels')
export class CommercialLabelsController {
  constructor(private readonly svc: CommercialLabelsService) {}

  @Get('search')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiQuery({ name: 'q', required: true, description: 'Texto: nombre / SKU / barcode (mín 2 chars).' })
  @ApiOperation({ summary: 'Etiquetera — búsqueda de catálogo para agregar productos a la cola de impresión.' })
  search(@Query('q') q: string) {
    return this.svc.search(q);
  }

  @Get('price-changes')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiQuery({ name: 'sucursal', required: true, description: 'Plaza de dos dígitos. Sin ella la lista va vacía: la bitácora es POR tienda.' })
  @ApiQuery({ name: 'fecha', required: false, description: 'Día a revisar (YYYY-MM-DD). Default: AYER en hora de México.' })
  @ApiOperation({
    summary: 'Etiquetera — cambios de precio de un día, con precio anterior y nuevo.',
    description:
      'Deriva de `analytics.v_label_price_changes` sobre la bitácora nativa de Kepler — la única ' +
      'fuente que guarda el precio ANTERIOR. Filtra a los cambios que mueven el precio IMPRESO: ' +
      'Kepler escribe una fila por recálculo y el 99.8% son deltas de menos de un centavo. ' +
      '`fuente_al` dice hasta qué día llegó la bitácora, para que "no cambió nada" y "todavía no ' +
      'llegó" no se vean iguales. `es_baja` marca el precio nuevo en cero: no es rebaja, es que el ' +
      'ERP le quitó el precio.',
  })
  priceChanges(@Query('sucursal') sucursal?: string, @Query('fecha') fecha?: string) {
    return this.svc.priceChanges(sucursal ?? null, fecha ?? null);
  }

  @Post('resolve')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiOperation({
    summary: 'Etiquetera — resuelve una lista de códigos (SKU o barcode) al modelo de la etiqueta de anaquel.',
    description:
      '`sucursal` (dos dígitos) imprime el precio DE ESA TIENDA. `[NORM.3]`: el precio de Kepler es por ' +
      'plaza (1,039 SKUs con precio de pieza distinto entre plazas, 1,164 grupos de mayoreo de paquete), ' +
      'y hasta ahora la etiqueta salía con la moda entre tiendas. Sin `sucursal` se responde esa misma ' +
      'forma consolidada — igual que hoy — para no romper a quien todavía no la manda.',
  })
  resolve(@Body() body: { codes: string[]; sucursal?: string }) {
    return this.svc.resolveForLabels(body?.codes || [], body?.sucursal ?? null);
  }
}
