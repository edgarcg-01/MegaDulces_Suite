import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { WhatsAppOrdersService } from './whatsapp-orders.service';

/**
 * Fase F.3 — Bandeja de pedidos WhatsApp (persona de tienda / operador de reparto).
 * Vive en `/whatsapp/orders`; el frontend la monta en `/reparto/pedidos-whatsapp`.
 * VER = leer la bandeja; GESTIONAR = confirmar/rechazar (crea el pedido real).
 */
@ApiTags('whatsapp-orders')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('whatsapp/orders')
export class WhatsAppOrdersController {
  constructor(private readonly service: WhatsAppOrdersService) {}

  @Get()
  @RequirePermissions(Permission.WHATSAPP_BOT_VER)
  @ApiOperation({ summary: 'Pedidos WhatsApp listos para aprobar (hilos en review) + carrito/domicilio/total.' })
  listPending() {
    return this.service.listPending();
  }

  @Post(':threadId/confirm')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Confirma el pedido: crea la orden a domicilio, avisa al cliente y cierra el hilo.' })
  confirm(@Param('threadId') threadId: string) {
    return this.service.confirm(threadId);
  }

  @Post(':threadId/reject')
  @RequirePermissions(Permission.WHATSAPP_BOT_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza el pedido: cierra el hilo y avisa al cliente.' })
  reject(@Param('threadId') threadId: string, @Body() body: { reason?: string }) {
    return this.service.reject(threadId, body?.reason);
  }
}
