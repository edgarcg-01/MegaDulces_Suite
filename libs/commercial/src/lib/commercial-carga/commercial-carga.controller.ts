import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialCargaService } from './commercial-carga.service';
import type { SetLoadStatusDto } from './commercial-carga.service';

@ApiTags('commercial-carga')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/carga')
export class CommercialCargaController {
  constructor(private readonly service: CommercialCargaService) {}

  @Get('load-status')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Estados de carga (loaded/not_loaded) de las líneas de los pedidos dados (order_ids CSV).' })
  getStatuses(@Query('order_ids') orderIds?: string) {
    return this.service.getStatuses(
      (orderIds || '').split(',').map((s) => s.trim()).filter(Boolean),
    );
  }

  @Put('load-status')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Marcar una línea de carga: loaded / not_loaded (+motivo) / pending (borra).' })
  setStatus(@Body() body: SetLoadStatusDto) {
    return this.service.setStatus(body);
  }

  @Post('load-status/bulk')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Marcar varias líneas de carga de una (toggle por pedido o por producto).' })
  setStatusBulk(@Body() body: { items: SetLoadStatusDto[] }) {
    return this.service.setStatusBulk(body?.items || []);
  }
}
