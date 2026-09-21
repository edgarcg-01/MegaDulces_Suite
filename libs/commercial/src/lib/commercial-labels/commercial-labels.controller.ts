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
  @ApiQuery({ name: 'sucursal', required: true, description: 'Plaza de dos dígitos. Sin ella la lista va vacía: el reloj de cambio es POR tienda.' })
  @ApiQuery({ name: 'horas', required: false, description: 'Ventana en horas (1–168, default 24).' })
  @ApiOperation({
    summary: 'Etiquetera — productos cuyo precio cambió, para reimprimir su etiqueta.',
    description:
      'El reloj es `commercial.product_label_prices.updated_at` (UPSERT churn-free: sólo toca la fila ' +
      'cuando cambia). El PRECIO sale de `analytics.v_label_prices`, como toda la etiquetera. ' +
      '⛔ NO devuelve precio anterior: ninguna tabla lo guarda (deuda VP.3). Y la ventana útil es ' +
      'corta — a 7 días `updated_at` toca medio catálogo por una reescritura masiva. La fuente ' +
      'correcta sería `kdpv_bitacora_precios`, que lleva sin llegar al ODS desde el 2026-09-01.',
  })
  priceChanges(@Query('sucursal') sucursal?: string, @Query('horas') horas?: string) {
    return this.svc.priceChanges(sucursal ?? null, Number(horas ?? 24));
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
