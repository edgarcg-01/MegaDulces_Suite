import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  CommercialOrdersService,
  CreateDraftDto,
  AddLineDto,
  UpdateLineDto,
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

  @Post(':id/fulfill')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Entregar pedido (confirmed → fulfilled). Consume stock.' })
  fulfill(@Param('id') id: string) {
    return this.service.fulfill(id);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CANCELAR)
  @ApiOperation({ summary: 'Cancelar pedido. Libera reservas si estaba confirmed.' })
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    return this.service.cancel(id, body?.reason);
  }
}
