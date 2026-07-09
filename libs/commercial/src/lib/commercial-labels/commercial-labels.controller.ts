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

  @Post('resolve')
  @RequirePermissions(Permission.STORE_LABELS_VER)
  @ApiOperation({ summary: 'Etiquetera — resuelve una lista de códigos (SKU o barcode) al modelo de la etiqueta de anaquel.' })
  resolve(@Body() body: { codes: string[] }) {
    return this.svc.resolveForLabels(body?.codes || []);
  }
}
