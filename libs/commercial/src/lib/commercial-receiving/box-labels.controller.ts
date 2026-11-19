import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  BoxLabelCatalogDefectsResponse,
  BoxLabelOrdersResponse,
  BoxLabelPrintRequest,
  BoxLabelPrintResponse,
} from '@megadulces/contracts';
import { BoxLabelsService } from './box-labels.service';

/**
 * `[RE.ETQ.2.1–2.3]` Etiquetas de caja de la orden de entrada (TSC TE200), dentro de Recepción (D1).
 *
 * Una sola clave, `ALMACEN_ETIQUETAS_CAJA`, que ve Y hace: la pantalla existe para imprimir (ver el
 * comentario en `permissions.ts`). El alcance por sucursal lo aplica el servicio con ScopeService.
 */
@ApiTags('commercial-receiving')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/receiving/box-labels')
export class BoxLabelsController {
  constructor(private readonly service: BoxLabelsService) {}

  @Get('orders')
  @RequirePermissions(Permission.ALMACEN_ETIQUETAS_CAJA)
  @ApiOperation({
    summary:
      'Cola de órdenes de entrada de Kepler (X-A-40) con sus renglones en caja, cuántas etiquetas llevan y cuántas ya se ' +
      'enviaron a imprimir. date_from/date_to (AAAA-MM-DD, máx. 31 días; default últimos 7) y warehouse_codes.',
  })
  orders(@Query() query: Record<string, unknown>): Promise<BoxLabelOrdersResponse> {
    return this.service.ordenes(query);
  }

  @Get('catalog-defects')
  @RequirePermissions(Permission.ALMACEN_ETIQUETAS_CAJA)
  @ApiOperation({
    summary:
      'Productos recibidos en caja con el catálogo de Kepler mal: sin código de caja (c85), factor 0 o distinto al de la ' +
      'orden, o la caja en otra unidad. Para que Compras los corrija en Kepler. Default: últimos 30 días.',
  })
  catalogDefects(@Query() query: Record<string, unknown>): Promise<BoxLabelCatalogDefectsResponse> {
    return this.service.defectos(query);
  }

  @Post('prints')
  @HttpCode(200)
  @RequirePermissions(Permission.ALMACEN_ETIQUETAS_CAJA)
  @ApiOperation({
    summary:
      'Registra el envío a la impresora y devuelve las etiquetas. La primera vez de cada renglón fija la fecha (D6: el ' +
      'día de hoy en CDMX); toda reimpresión devuelve los datos congelados de la primera. Sin consecutivos = todas.',
  })
  print(@Body() body: BoxLabelPrintRequest): Promise<BoxLabelPrintResponse> {
    return this.service.imprimir(body);
  }
}
