import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { PedidoNegociacionDto } from '@megadulces/contracts';
import { PedidoNegociacionService } from './pedido-negociacion.service';

/** `[RA-NEG.1]` Costo y negociación de un producto, para el desglose de `/compras/pedido`. */
@ApiTags('commercial-replenishment')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/replenishment/negociacion')
export class PedidoNegociacionController {
  constructor(private readonly svc: PedidoNegociacionService) {}

  @Get(':productId')
  @RequirePermissions(Permission.COMPRAS_PEDIDO_VER)
  @ApiOperation({ summary: '[RA-NEG.1] Costo, precio, margen, lo pagado en 12 meses y el proveedor (compras, descuentos, pronto pago no tomado, plazo) de UN producto.' })
  negociacion(@Param('productId') productId: string): Promise<PedidoNegociacionDto> {
    return this.svc.negociacion(productId);
  }
}
