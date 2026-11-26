import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AplicacionCosto, DecisionCostoGuardada, GuardarDecisionCostoDto } from '@megadulces/contracts/http/application-cost';
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import { ApplicationCostService } from './application-cost.service';

interface Sesion {
  user?: { sub?: string; username?: string };
}

const quien = (req: Sesion) => ({ userId: String(req?.user?.sub ?? ''), username: req?.user?.username ?? null });

/**
 * `[PQ.157]` Compras › validar el costo al aplicar (anexo R §3d–§3e). Leer lo ve quien ya ve Revisión de facturas
 * (`COMPRAS_ENTRADAS_VER`) o quien decide; decidir es sólo `COMPRAS_COSTO_DECIDIR`: Compras (Francisco, 2026-11-26).
 */
@ApiTags('compras-costo-aplicado')
@Controller('compras/costo-aplicado')
export class ApplicationCostController {
  constructor(private readonly service: ApplicationCostService) {}

  @Get('aplicaciones/:sucursal/:folio')
  @RequireAnyPermission(Permission.COMPRAS_ENTRADAS_VER, Permission.COMPRAS_COSTO_DECIDIR)
  @ApiOperation({ summary: 'PQ.157: los renglones de una aplicación X-A-20 contra su OC (en la misma unidad), con su cadena (orden de entrada, vale, OC), la decisión viva y «ya se aceptó antes»' })
  aplicacion(@Param('sucursal') sucursal: string, @Param('folio') folio: string): Promise<AplicacionCosto> {
    return this.service.aplicacion(sucursal, folio);
  }

  @Post('decisiones')
  @RequirePermissions(Permission.COMPRAS_COSTO_DECIDIR)
  @ApiOperation({ summary: 'PQ.157: decidir el costo de un renglón que difiere de su OC: accept, claim (nota de crédito esperada) o promotion (con fecha de fin). Reemplaza la decisión viva; nada se borra' })
  decidir(@Body() dto: GuardarDecisionCostoDto, @Req() req: Sesion): Promise<DecisionCostoGuardada> {
    return this.service.decidir(quien(req), dto);
  }
}
