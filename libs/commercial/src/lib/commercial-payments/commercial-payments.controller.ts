import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CommercialPaymentsService } from './commercial-payments.service';
import { DeliverAndCollectDto, RecordPaymentDto } from './dto/payment.dto';

@ApiTags('commercial-payments')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/payments')
export class CommercialPaymentsController {
  constructor(private readonly service: CommercialPaymentsService) {}

  /** Registra un cobro sobre un pedido (cash/transfer/card/prepaid). */
  @Post()
  @RequirePermissions(Permission.COMMERCIAL_PAYMENTS_REGISTRAR)
  @ApiOperation({ summary: 'Registra un cobro contra un pedido.' })
  record(@Body() dto: RecordPaymentDto) {
    return this.service.recordPayment(dto);
  }

  /** Entrega + cobro atómicos (repartidor en la parada). */
  @Post('orders/:orderId/deliver-collect')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL, Permission.COMMERCIAL_PAYMENTS_REGISTRAR)
  @ApiOperation({ summary: 'Entrega el pedido (fulfill) y registra el cobro en una transacción.' })
  deliverCollect(@Param('orderId') orderId: string, @Body() dto: DeliverAndCollectDto) {
    return this.service.deliverAndCollect(orderId, dto ?? {});
  }

  /** El encargado verifica el comprobante de una transferencia/tarjeta. */
  @Post(':id/verify')
  @RequirePermissions(Permission.COMMERCIAL_PAYMENTS_VERIFICAR)
  @ApiOperation({ summary: 'Marca un cobro (transferencia/tarjeta) como verificado.' })
  verify(@Param('id') id: string) {
    return this.service.verifyTransfer(id);
  }

  /** Reversa un cobro (error de captura). */
  @Post(':id/reverse')
  @RequirePermissions(Permission.COMMERCIAL_PAYMENTS_REVERSAR)
  @ApiOperation({ summary: 'Reversa un cobro y devuelve el saldo al pedido.' })
  reverse(@Param('id') id: string, @Body('reason') reason?: string) {
    return this.service.reversePayment(id, reason);
  }

  /** Lista los cobros de un pedido. */
  @Get('orders/:orderId')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Lista los cobros de un pedido.' })
  listByOrder(@Param('orderId') orderId: string) {
    return this.service.listByOrder(orderId);
  }
}
