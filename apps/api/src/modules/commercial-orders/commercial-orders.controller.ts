import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  CommercialOrdersService,
  CreateDraftDto,
  AddLineDto,
  UpdateLineDto,
  UpdateOrderDraftDto,
  OrderStatus,
} from './commercial-orders.service';

@ApiTags('commercial-orders')
@Controller('commercial/orders')
export class CommercialOrdersController {
  constructor(private readonly service: CommercialOrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Crear pedido en estado draft' })
  createDraft(@Body() body: CreateDraftDto) {
    return this.service.createDraft(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar pedidos (paginado + filtros)' })
  list(
    @Query('status') status?: OrderStatus,
    @Query('customer_id') customerId?: string,
    @Query('user_id') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({
      status,
      customer_id: customerId,
      user_id: userId,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('my')
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

  @Get(':id')
  @ApiOperation({ summary: 'Obtener pedido con líneas' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Historial de cambios de status del pedido (audit trail)' })
  history(@Param('id') id: string) {
    return this.service.getHistory(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'J.6.6: actualiza notes / delivery_type del pedido (solo en draft)',
  })
  updateDraft(@Param('id') id: string, @Body() body: UpdateOrderDraftDto) {
    return this.service.updateDraft(id, body);
  }

  @Post(':id/lines')
  @ApiOperation({ summary: 'Agregar línea (solo si draft)' })
  addLine(@Param('id') orderId: string, @Body() body: AddLineDto) {
    return this.service.addLine(orderId, body);
  }

  @Patch(':id/lines/:line_id')
  @ApiOperation({ summary: 'Editar línea (solo si draft)' })
  updateLine(
    @Param('id') orderId: string,
    @Param('line_id') lineId: string,
    @Body() body: UpdateLineDto,
  ) {
    return this.service.updateLine(orderId, lineId, body);
  }

  @Delete(':id/lines/:line_id')
  @ApiOperation({ summary: 'Eliminar línea (solo si draft)' })
  removeLine(@Param('id') orderId: string, @Param('line_id') lineId: string) {
    return this.service.removeLine(orderId, lineId);
  }

  @Post(':id/confirm')
  @ApiOperation({
    summary:
      'Confirmar pedido por el CLIENTE (draft → pending_approval). Reserva stock; espera aprobación del vendedor.',
  })
  confirm(@Param('id') id: string) {
    return this.service.confirm(id);
  }

  @Post(':id/approve')
  @ApiOperation({
    summary:
      'Aprobar pedido por el VENDEDOR (pending_approval → confirmed). Sin cambio de inventario.',
  })
  approve(@Param('id') id: string) {
    return this.service.approve(id);
  }

  @Post(':id/fulfill')
  @ApiOperation({ summary: 'Entregar pedido (confirmed → fulfilled). Consume stock.' })
  fulfill(@Param('id') id: string) {
    return this.service.fulfill(id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancelar pedido. Libera reservas si estaba confirmed.' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancel(id, body?.reason);
  }
}
