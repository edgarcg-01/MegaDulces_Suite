import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { FlujoComprasDto } from '@megadulces/contracts';
import { PurchaseFlowService } from './purchase-flow.service';

/**
 * `[RA-PRO.63]` Flujo de compras (pestaña "Flujo" de `/compras/pedido`). Solo lectura: se ve con
 * el mismo permiso que el pedido. El alcance por sucursal lo aplica el servicio.
 */
@ApiTags('commercial-replenishment')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/replenishment/purchase-flow')
export class PurchaseFlowController {
  constructor(private readonly svc: PurchaseFlowService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_PEDIDO_VER)
  @ApiOperation({ summary: 'Requisición → OC Kepler → entrada: liga sugerida, surtido y productos negados' })
  flow(@Query('dias') dias?: string, @Query('sucursal') sucursal?: string): Promise<FlujoComprasDto> {
    return this.svc.flow({ dias, sucursal });
  }
}
