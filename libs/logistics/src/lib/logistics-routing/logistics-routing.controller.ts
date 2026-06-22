import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { LogisticsRoutingService, OptimizeDto, BuildShipmentDto } from './logistics-routing.service';

@ApiTags('logistics-routing')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('logistics/routing')
export class LogisticsRoutingController {
  constructor(private readonly service: LogisticsRoutingService) {}

  @Post('optimize')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Optimizar secuencia de paradas (stateless, para el planner)' })
  optimize(@Body() body: OptimizeDto) {
    return this.service.optimize(body);
  }

  @Post('optimize-shipment/:id')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Optimizar reparto del embarque y persistir sequence_order' })
  optimizeShipment(@Param('id') id: string) {
    return this.service.optimizeShipment(id);
  }

  @Get('shipment/:id/plan')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_VER)
  @ApiOperation({ summary: 'Plan de ruta del embarque (origen + paradas con coords, ordenadas)' })
  shipmentPlan(@Param('id') id: string) {
    return this.service.shipmentPlan(id);
  }

  @Post('build-shipment')
  @RequirePermissions(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Armar embarque desde pedidos pendientes (crea shipment+guía+destinatarios+optimiza)' })
  buildShipment(@Body() body: BuildShipmentDto) {
    return this.service.buildShipmentFromOrders(body);
  }
}
