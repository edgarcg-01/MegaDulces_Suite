import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isPlatformAdminRole, Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { PedidoNegociacionDto } from '@megadulces/contracts';
import { PedidoNegociacionService } from './pedido-negociacion.service';

/** Lo que `RolesGuard` deja en `req.user`: permisos y roles FRESCOS de la base, no el JWT. */
interface Actor { role_name?: string; roles_frescos?: string[]; permissions?: Record<string, boolean> }

/** `[RA-NEG.3]` ¿Puede ver Descuentos? El god-mode va por ROL (ADR-054), igual que en el guard. */
function puedeVerDescuentos(u?: Actor): boolean {
  if (!u) return false;
  const roles = u.roles_frescos ?? (u.role_name ? [u.role_name] : []);
  return roles.some((r) => isPlatformAdminRole(r)) || u.permissions?.[Permission.COMPRAS_DESCUENTOS_VER] === true;
}

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
  negociacion(@Param('productId') productId: string, @Req() req?: { user?: Actor }): Promise<PedidoNegociacionDto> {
    return this.svc.negociacion(productId, puedeVerDescuentos(req?.user));
  }
}
