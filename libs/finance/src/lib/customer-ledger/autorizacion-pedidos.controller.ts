import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { RequestConCabeceras } from '@megadulces/platform-core';
// `import type`: con `emitDecoratorMetadata` + `isolatedModules`, un tipo en la firma de un método decorado entra así (TS1272).
import type { DecisionPedidoBody, ResultadoDecisionPedido } from '@megadulces/contracts';
import { AutorizacionDecisionService } from './autorizacion-decision.service';

interface AuthedRequest extends RequestConCabeceras { user?: { username?: string } }

/**
 * `[GP.A.2]` La decisión de Crédito y cobranza sobre un pedido TELEMARK (autorizar, regresar, rechazar o pasar a
 * Dirección General). La bandeja se lee en `GET /api/finance/receivables/autorizacion-pedidos`; esto escribe, con su
 * propia llave y un prefijo propio para no competir con `:sucursal/:cliente` de `CustomerLedgerController`.
 */
@ApiTags('finance-autorizacion-pedidos')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/autorizacion-pedidos')
export class AutorizacionPedidosController {
  constructor(private readonly svc: AutorizacionDecisionService) {}

  @Post(':sucursal/:serie/:folio')
  @RequirePermissions(Permission.FINANCE_PEDIDOS_AUTORIZAR)
  @ApiOperation({ summary: '[GP.A.2] Autoriza, regresa, rechaza o pasa a Dirección un pedido TELEMARK; autorizar y regresar escriben kdm1.c11 en Kepler.' })
  decidir(
    @Param('sucursal') sucursal: string, @Param('serie') serie: string, @Param('folio') folio: string,
    @Body() body: DecisionPedidoBody, @Req() req: AuthedRequest,
  ): Promise<ResultadoDecisionPedido> {
    return this.svc.decidir(sucursal, serie, folio, body, req.user?.username);
  }
}
