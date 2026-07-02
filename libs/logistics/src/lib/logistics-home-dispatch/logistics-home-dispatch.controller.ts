import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RequireAuthGuard,
  RolesGuard,
  RequirePermissions,
  Permission,
} from '@megadulces/platform-core';
import { DispatchHomeDeliveryDto, LogisticsHomeDispatchService } from './logistics-home-dispatch.service';

@ApiTags('logistics-home-dispatch')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('logistics/home-dispatch')
export class LogisticsHomeDispatchController {
  constructor(private readonly service: LogisticsHomeDispatchService) {}

  /** Despacha un pedido a domicilio a un repartidor en moto (embarque + guía + parada). */
  @Post('orders/:orderId')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Asigna un pedido a domicilio a un repartidor+moto; avisa si excede capacidad (CEDIS).' })
  dispatch(@Param('orderId') orderId: string, @Body() dto: DispatchHomeDeliveryDto) {
    return this.service.dispatch(orderId, dto);
  }

  /** Paradas a domicilio del repartidor autenticado (app repartidor). */
  @Get('my-deliveries')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Lista las paradas a domicilio asignadas al repartidor.' })
  myDeliveries(@Query('pending') pending?: string) {
    return this.service.myDeliveries({ pending: pending !== 'false' });
  }
}
