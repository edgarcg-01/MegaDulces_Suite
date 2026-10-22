import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequireAnyPermission, Permission, isPlatformAdminRole } from '@megadulces/platform-core';
import { EntityRefService } from './entity-ref.service';

/**
 * Resolvedor de referencias — una sola puerta para "abrí ese registro".
 *
 * Ruta NEUTRAL a propósito (`/entity-ref`, no `/compras/...`): hoy la consumen
 * /compras/entradas y /compras/compras-360, pero el contrato no tiene nada de compras
 * y la idea es que Finanzas abra el mismo proveedor con el mismo ref.
 *
 * Entrada: `@RequireAnyPermission` con los permisos de las dos pantallas que ya lo usan.
 * Adentro, el service vuelve a chequear POR TIPO de entidad y filtra las relaciones que
 * el rol no puede abrir — el permiso de entrada no es un pase libre a pagos ni a ajustes.
 */
@ApiTags('entity-ref')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('entity-ref')
export class EntityRefController {
  constructor(private readonly svc: EntityRefService) {}

  @Get(':ref')
  // `[TP.20.5]` Tesorería entra por su propio permiso. Antes la puerta era 100% de Compras, así
  // que la ficha de una factura por pagar —que es suya— le daba 403 en la cara. El permiso de
  // entrada sigue sin ser un pase libre: adentro `can()` vuelve a filtrar POR TIPO.
  @RequireAnyPermission(
    Permission.COMPRAS_360_VER, Permission.COMPRAS_ENTRADAS_VER, Permission.COMPRAS_DESCUENTOS_VER,
    Permission.FINANCE_PAYMENTS_VER,
  )
  @ApiOperation({ summary: 'Resuelve un ref (ent|lin|adj|pay|prov|sku|pdoc|oblig) a { title, badges, fields[], relations[], notes[] }. Cada relación trae SU ref → el panel navega sin saber de tablas.' })
  resolve(@Param('ref') ref: string, @Req() req: any) {
    const perms = (req?.user?.permissions ?? {}) as Record<string, boolean>;
    return this.svc.resolve(ref, { perms, isAdmin: isPlatformAdminRole(req?.user?.role_name) });
  }
}
