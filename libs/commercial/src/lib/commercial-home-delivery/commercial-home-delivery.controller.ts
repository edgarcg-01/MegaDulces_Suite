import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { CommercialHomeDeliveryService } from './commercial-home-delivery.service';
import { HomeDeliveryIntakeDto, RecordDeliveryOutcomeDto } from './dto/home-delivery.dto';

@ApiTags('commercial-home-delivery')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('commercial/home-delivery')
export class CommercialHomeDeliveryController {
  constructor(private readonly service: CommercialHomeDeliveryService) {}

  /** Intake de un pedido a domicilio (cliente casual o de cartera + dirección). */
  @Post('orders')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_CREAR)
  @ApiOperation({ summary: 'Recibe un pedido a domicilio y lo deja confirmado (stock reservado).' })
  createIntake(@Body() dto: HomeDeliveryIntakeDto) {
    return this.service.createIntake(dto);
  }

  /** El repartidor cierra la parada: entrega (evidencia + cobro) o incidencia. */
  @Post('recipients/:recipientId/outcome')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL, Permission.COMMERCIAL_PAYMENTS_REGISTRAR)
  @ApiOperation({ summary: 'Registra el resultado de la parada (entregado/incidencia) + POD + cobro.' })
  recordOutcome(@Param('recipientId') recipientId: string, @Body() dto: RecordDeliveryOutcomeDto) {
    return this.service.recordDeliveryOutcome(recipientId, dto);
  }
}
