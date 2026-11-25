import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { RequestConCabeceras } from '@megadulces/platform-core';
// `import type`: con `emitDecoratorMetadata` + `isolatedModules`, un tipo en la firma de un método decorado entra así (TS1272).
import type { CerrarRestosBody, ResultadoAjusteAbono } from '@megadulces/contracts';
import { AjusteAbonoService } from './ajuste-abono.service';

interface AuthedRequest extends RequestConCabeceras { user?: { username?: string } }

/**
 * `[GP.R.3]` **Cerrar los restos de centavos de un cliente** con el Ajuste Abono `U-A-30` de Kepler, en vez del
 * «Cobro» de centavos que afirma que entró dinero y no entró (74 en 60 días contra cero ajustes).
 *
 * Prefijo propio para no competir con `:sucursal/:cliente` de `CustomerLedgerController`. Cuatro candados antes de
 * escribir: la migración aplicada · el interruptor `ajuste_abono` encendido en esa sucursal (nace apagado) ·
 * `KEPLER_AJUSTE_ABONO_ESCRITURA=encendida` · el `GRANT` en el Kepler de la sucursal.
 *
 * ⛔ La respuesta trae `cfdi_insoluto`: lo que la factura **sigue debiendo ante el SAT** después del ajuste, porque
 * un Ajuste Abono no emite CFDI. `null` = no se pudo medir, que no es cero.
 */
@ApiTags('finance-ajuste-abono')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/ajuste-abono')
export class AjusteAbonoController {
  constructor(private readonly svc: AjusteAbonoService) {}

  /**
   * `[GP.R.4]` Si en esta sucursal se puede cerrar un resto. La pantalla lo pregunta **antes** de ofrecer el acto:
   * un botón que va a fallar es el error como primer recurso.
   */
  @Get(':sucursal')
  @RequirePermissions(Permission.FINANCE_RESTOS_CERRAR)
  @ApiOperation({ summary: '[GP.R.4] Dice si el cierre de restos está habilitado en esa sucursal (interruptor + bandera), y por qué no si está apagado.' })
  habilitado(@Param('sucursal') sucursal: string): Promise<{ habilitado: boolean; motivo?: string }> {
    return this.svc.habilitadoEn(sucursal);
  }

  @Post(':sucursal')
  @RequirePermissions(Permission.FINANCE_RESTOS_CERRAR)
  @ApiOperation({ summary: '[GP.R.3] Cierra los restos de centavos de un cliente con el Ajuste Abono U-A-30 de Kepler (hasta $10, D-R1). No emite CFDI: declara el insoluto que deja ante el SAT.' })
  cerrar(
    @Param('sucursal') sucursal: string,
    @Body() body: CerrarRestosBody, @Req() req: AuthedRequest,
  ): Promise<ResultadoAjusteAbono> {
    return this.svc.cerrarRestos(sucursal, body, req.user?.username);
  }
}
