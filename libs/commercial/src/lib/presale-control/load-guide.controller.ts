import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  RequireAuthGuard,
  RolesGuard,
  RequireAnyPermission,
  RequirePermissions,
  Permission,
  isPlatformAdminRole,
} from '@megadulces/platform-core';
import type {
  LoadGuidesResponse,
  PresaleFieldResponse,
  PresaleLoadRequest,
  PresaleUnloadRequest,
} from '@megadulces/contracts';
import { LoadGuideService } from './load-guide.service';

/** Lo que `RolesGuard` deja en la petición: permisos y roles FRESCOS (no los del token). */
type ReqUsuario = { user?: { permissions?: Record<string, boolean>; roles_frescos?: string[] } };

/**
 * ¿Quien pide es repartidor? Ve por sucursal; si no, es vendedor y ve sólo lo suyo. El modo god
 * (también como rol complementario, que es como lo tienen superuser y guillermo_lopez) cuenta
 * como repartidor para no recortarle nada.
 */
function esRepartidor(req: ReqUsuario): boolean {
  const u = req.user;
  if (u?.roles_frescos?.some((r) => isPlatformAdminRole(r))) return true;
  return u?.permissions?.[Permission.REPARTO_ENTREGAR] === true;
}

/**
 * `[MCP.5]` El celular del repartidor o del vendedor: pescar los pedidos de preventa que se lleva.
 * Acepta a los dos: el repartidor trae `REPARTO_ENTREGAR`, el vendedor `COMMERCIAL_ORDERS_FULFILL`
 * (medido: `vendedor_ruta` no tiene la de repartidor).
 */
@ApiTags('field-presale')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('field/presale')
export class PresaleFieldController {
  constructor(private readonly svc: LoadGuideService) {}

  @Get()
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Pedidos de preventa que puedo pescar (confirmados, sin guía) y mis guías de hoy.' })
  campo(@Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.campo(query, esRepartidor(req));
  }

  @Post('load')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Pesca pedidos: los agrega a mi guía abierta de hoy de su sucursal y ruta (una guía por ruta).' })
  cargar(@Body() body: PresaleLoadRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.cargar(body?.order_ids, query, esRepartidor(req));
  }

  @Post('unload')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Quita un pedido de mi guía, mientras la guía no se haya impreso.' })
  descargar(@Body() body: PresaleUnloadRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.descargar(body?.order_id, query, esRepartidor(req));
  }
}

/**
 * `[MCP.5]` La caja: ver las guías de carga del día de su sucursal e imprimirlas (o reimprimirlas).
 * Permiso propio `PREVENTA_GUIAS_GESTIONAR` (la cajera no tiene claves de pedidos).
 */
@ApiTags('warehouse-presale-guides')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/presale-guides')
export class PresaleGuidesController {
  constructor(private readonly svc: LoadGuideService) {}

  @Get()
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Guías de carga del día (date=YYYY-MM-DD, default hoy) de las sucursales de mi alcance, con sus pedidos.' })
  listar(@Query() query: Record<string, unknown>): Promise<LoadGuidesResponse> {
    return this.svc.listar(query);
  }

  @Post(':id/print')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Imprime la guía en PDF. La primera vez la congela (lo que firma el repartidor); después reimprime esa misma foto marcada REIMPRESIÓN.' })
  async imprimir(@Param('id') id: string, @Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    const { pdf, guia } = await this.svc.imprimir(id, query);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${guia.folio}.pdf"`);
    res.setHeader('X-Guia-Folio', guia.folio);
    res.setHeader('Access-Control-Expose-Headers', 'X-Guia-Folio');
    res.end(pdf);
  }
}
