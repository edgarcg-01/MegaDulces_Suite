import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialOrdersService,
  CreateDraftDto,
  AddLineDto,
  UpdateLineDto,
  ReplaceLinesDto,
  UpdateOrderDraftDto,
  OrderStatus,
} from './commercial-orders.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

@ApiTags('commercial-orders')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/orders')
export class CommercialOrdersController {
  constructor(private readonly service: CommercialOrdersService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({ summary: 'Crear pedido en estado draft' })
  createDraft(@Body() body: CreateDraftDto) {
    return this.service.createDraft(body);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Listar pedidos (paginado + filtros). Si el rol es customer_b2b, el filtro customer_id se fuerza al customer del JWT — no puede listar pedidos ajenos.',
  })
  list(
    @Query('status') status?: OrderStatus,
    @Query('statuses') statuses?: string,
    @Query('customer_id') customerId?: string,
    @Query('user_id') userId?: string,
    @Query('mine') mine?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({
      status,
      statuses,
      customer_id: customerId,
      user_id: userId,
      mine: mine === 'true',
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('my')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary: 'Pedidos del customer del JWT (Portal B2B — rol customer_b2b)',
  })
  myOrders(
    @Query('status') status?: OrderStatus,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listMyOrders({
      status,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('counts')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Conteo de pedidos agrupado por status en 1 request (reemplaza el N+1 de los chips). Respeta filtros from/to/mine/customer_id.',
  })
  counts(
    @Query('customer_id') customerId?: string,
    @Query('user_id') userId?: string,
    @Query('mine') mine?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.countsByStatus({
      customer_id: customerId,
      user_id: userId,
      mine: mine === 'true',
      from,
      to,
    });
  }

  @Get('kpi-series')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'J16: serie diaria de monto + conteo de pedidos (para el sparkline del KPI hero). Mismos filtros que /counts; default últimos 30 días.',
  })
  kpiSeries(
    @Query('customer_id') customerId?: string,
    @Query('user_id') userId?: string,
    @Query('mine') mine?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.dailySeries({
      customer_id: customerId,
      user_id: userId,
      mine: mine === 'true',
      from,
      to,
    });
  }

  @Get('frequent/:customer_id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'VQ: productos habituales del cliente (agregado de pedidos confirmed/fulfilled) con cantidad promedio. Alimenta el order pad del vendedor.',
  })
  frequent(
    @Param('customer_id') customerId: string,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.frequentProducts(customerId, {
      days: days ? Number(days) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'Obtener pedido con líneas. customer_b2b solo puede leer SUS propios pedidos (ownership check en el service).',
  })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/history')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Historial de cambios de status del pedido (audit trail)' })
  history(@Param('id') id: string) {
    return this.service.getHistory(id);
  }

  @Get(':id/shipments')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'J.10: shipments asociados al pedido (tracking). customer_b2b solo puede ver shipments de SUS propios pedidos.',
  })
  shipments(@Param('id') id: string) {
    return this.service.getShipments(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({
    summary: 'J.6.6: actualiza notes / delivery_type del pedido (solo en draft)',
  })
  updateDraft(@Param('id') id: string, @Body() body: UpdateOrderDraftDto) {
    return this.service.updateDraft(id, body);
  }

  @Post(':id/lines')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({ summary: 'Agregar línea (solo si draft)' })
  addLine(@Param('id') orderId: string, @Body() body: AddLineDto) {
    return this.service.addLine(orderId, body);
  }

  @Put(':id/lines')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({
    summary:
      'VQ: reemplaza TODAS las líneas del draft con el set provisto en 1 transacción (order pad). Omite productos sin precio y los reporta.',
  })
  replaceLines(@Param('id') orderId: string, @Body() body: ReplaceLinesDto) {
    return this.service.replaceLines(orderId, body);
  }

  @Patch(':id/lines/:line_id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({ summary: 'Editar línea (solo si draft)' })
  updateLine(
    @Param('id') orderId: string,
    @Param('line_id') lineId: string,
    @Body() body: UpdateLineDto,
  ) {
    return this.service.updateLine(orderId, lineId, body);
  }

  @Delete(':id/lines/:line_id')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({ summary: 'Eliminar línea (solo si draft)' })
  removeLine(@Param('id') orderId: string, @Param('line_id') lineId: string) {
    return this.service.removeLine(orderId, lineId);
  }

  @Post(':id/confirm')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({
    summary:
      'Confirmar pedido por el CLIENTE (draft → pending_approval). Reserva stock; espera aprobación del vendedor.',
  })
  confirm(@Param('id') id: string) {
    return this.service.confirm(id);
  }

  @Post(':id/approve')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CONFIRMAR)
  @ApiOperation({
    summary:
      'Aprobar pedido por el VENDEDOR (pending_approval → confirmed). Sin cambio de inventario.',
  })
  approve(@Param('id') id: string) {
    return this.service.approve(id);
  }

  @Post(':id/place')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CONFIRMAR)
  @ApiOperation({
    summary:
      'Tomar pedido en campo (preventa): draft → confirmed en 1 transacción atómica e idempotente. Reemplaza updateDraft+confirm+approve del vendedor. Acepta fecha de entrega / notes / delivery_type en el body.',
  })
  place(@Param('id') id: string, @Body() body: UpdateOrderDraftDto) {
    return this.service.place(id, body);
  }

  @Post(':id/fulfill')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Entregar pedido (confirmed → fulfilled). Consume stock.' })
  fulfill(@Param('id') id: string) {
    return this.service.fulfill(id);
  }

  @Post(':id/deliver-now')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({
    summary:
      'V.5 autoventa: entrega inmediata. Fast-forward (draft/pending_approval/confirmed) → fulfilled en un paso. Consume stock.',
  })
  deliverNow(@Param('id') id: string) {
    return this.service.deliverNow(id);
  }

  @Post(':id/facturar')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @ApiOperation({
    summary:
      'FE.5: emite y timbra el CFDI (nominativa) de un pedido entregado. Requiere datos fiscales del cliente. Idempotente (409 si ya tiene CFDI).',
  })
  facturar(@Param('id') id: string) {
    return this.service.issueForOrder(id);
  }

  @Post(':id/self-invoice')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({
    summary:
      'FE.7 (Portal B2B): el cliente factura SU propio pedido entregado. Ownership forzado + solo customer_b2b. Acepta datos fiscales para capturarlos antes de timbrar. Idempotente (409 si ya tiene CFDI).',
  })
  selfInvoice(
    @Param('id') id: string,
    @Body() body: { rfc?: string; legal_name?: string; regimen_fiscal?: string; uso_cfdi?: string; zip?: string },
  ) {
    return this.service.selfInvoiceOrder(id, body);
  }

  @Get(':id/cfdi-xml')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({ summary: 'FE.7: XML timbrado del CFDI del pedido (ownership: customer_b2b solo el suyo).' })
  cfdiXml(@Param('id') id: string) {
    return this.service.getCfdiXml(id);
  }

  @Get(':id/cfdi-pdf')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'FE.7: PDF (base64) del CFDI del pedido. Devuelve { pdf_base64 }.' })
  cfdiPdf(@Param('id') id: string) {
    return this.service.getCfdiPdf(id);
  }

  @Post('global-invoice')
  @RequirePermissions(Permission.FISCAL_FACTURAR_GESTIONAR)
  @ApiOperation({
    summary:
      'FE.6: emite la factura global de mostrador de un día (body.date YYYY-MM-DD, default hoy). Agrega los pedidos entregados SIN datos fiscales del cliente en 1 CFDI global.',
  })
  globalInvoice(@Body() body: { date?: string }) {
    return this.service.issueDailyGlobal(body?.date);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CANCELAR)
  @ApiOperation({ summary: 'Cancelar pedido. Libera reservas si estaba confirmed.' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancel(id, body?.reason);
  }
}
