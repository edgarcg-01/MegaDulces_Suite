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
  LoadGuideLiquidationPreview,
  LoadGuideLiquidationsResponse,
  LoadGuidesResponse,
  PresaleLiquidateRequest,
  PresaleLiquidationPreviewRequest,
  PresaleDeliverRequest,
  PresaleFieldOrderDetail,
  PresaleFieldResponse,
  PresaleLoadRequest,
  PresaleNotDeliveredRequest,
  PresaleReturnRequest,
  PresaleUnloadRequest,
} from '@megadulces/contracts';
import { LoadGuideService, type QuienPide } from './load-guide.service';

/** Lo que `RolesGuard` deja en la petición: permisos y roles FRESCOS (no los del token). */
type ReqUsuario = { user?: { permissions?: Record<string, boolean>; roles_frescos?: string[] } };

/**
 * Quién pide. El modo god se mira en los roles FRESCOS (principal + complementarios): así cuenta el
 * de `superuser` y `guillermo_lopez`, que lo tienen por complemento. Repartidor = trae
 * `REPARTO_ENTREGAR`; si no, es vendedor y sólo ve lo que él levantó.
 */
function quienPide(req: ReqUsuario): QuienPide {
  const u = req.user;
  const god = !!u?.roles_frescos?.some((r) => isPlatformAdminRole(r));
  return { god, repartidor: god || u?.permissions?.[Permission.REPARTO_ENTREGAR] === true };
}

/**
 * `[MCP.5]` El celular del repartidor o del vendedor: pescar los pedidos de preventa que se lleva.
 * Acepta a los dos: el repartidor trae `REPARTO_ENTREGAR`, el vendedor `COMMERCIAL_ORDERS_FULFILL`
 * (medido: `vendedor_ruta` no tiene la de repartidor). Quien tenga FULFILL sin ser repartidor sólo
 * ve los pedidos que él levantó.
 */
@ApiTags('field-presale')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('field/presale')
export class PresaleFieldController {
  constructor(private readonly svc: LoadGuideService) {}

  @Get()
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Pedidos de preventa que puedo pescar (confirmados, sin guía) y mis guías abiertas y de hoy.' })
  campo(@Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.campo(query, quienPide(req));
  }

  @Post('load')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Pesca pedidos: los agrega a mi guía abierta de hoy de su sucursal y ruta (una guía por ruta).' })
  cargar(@Body() body: PresaleLoadRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.cargar(body?.order_ids, query, quienPide(req));
  }

  @Post('unload')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: 'Quita un pedido de mi guía, mientras la guía no se haya impreso.' })
  descargar(@Body() body: PresaleUnloadRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.descargar(body?.order_id, query, quienPide(req));
  }

  @Get('orders/:orderId')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: '[MCP.6] Un pedido de mi guía para entregarlo: renglones y documentos de Kepler del cliente (el más parecido primero).' })
  detalle(@Param('orderId') orderId: string, @Req() req: ReqUsuario): Promise<PresaleFieldOrderDetail> {
    return this.svc.detalleCampo(orderId, quienPide(req));
  }

  @Post('deliver')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: '[MCP.6] Entrega de conformidad: liga el documento de Kepler y registra resultado y cobro. No factura ni mueve inventario.' })
  entregar(@Body() body: PresaleDeliverRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.entregar(body, query, quienPide(req));
  }

  @Post('not-delivered')
  @RequireAnyPermission(Permission.REPARTO_ENTREGAR, Permission.COMMERCIAL_ORDERS_FULFILL)
  @ApiOperation({ summary: '[MCP.6] No se pudo entregar (con motivo): el pedido queda libre para salir otro día.' })
  noEntregado(@Body() body: PresaleNotDeliveredRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<PresaleFieldResponse> {
    return this.svc.noEntregado(body, query, quienPide(req));
  }
}

/**
 * `[MCP.5]` La caja: ver las guías de carga de su sucursal, imprimirlas (o reimprimirlas) y
 * registrar lo que regresó sin entregar. Permiso propio `PREVENTA_GUIAS_GESTIONAR`.
 */
@ApiTags('warehouse-presale-guides')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('warehouse/presale-guides')
export class PresaleGuidesController {
  constructor(private readonly svc: LoadGuideService) {}

  @Get()
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Guías de carga del día (date=YYYY-MM-DD, default hoy) más las abiertas de días anteriores, de las sucursales de mi alcance.' })
  listar(@Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<LoadGuidesResponse> {
    return this.svc.listar(query, quienPide(req));
  }

  @Post(':id/print')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Imprime la guía en PDF. La primera vez la congela (lo que firma el repartidor); después reimprime esa misma foto marcada REIMPRESIÓN.' })
  async imprimir(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario, @Res() res: Response): Promise<void> {
    const { pdf, guia } = await this.svc.imprimir(id, query, quienPide(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${guia.folio}.pdf"`);
    res.setHeader('X-Guia-Folio', guia.folio);
    res.setHeader('Access-Control-Expose-Headers', 'X-Guia-Folio');
    res.end(pdf);
  }

  @Get('liquidations')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: '[MCP.7] Liquidaciones del día (date=YYYY-MM-DD, default hoy) de las sucursales de mi alcance.' })
  liquidaciones(@Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<LoadGuideLiquidationsResponse> {
    return this.svc.liquidaciones(query, quienPide(req));
  }

  @Post('liquidation/preview')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: '[MCP.7] Lo que se espera al liquidar un regreso: entregado, declarado en efectivo y transferencia, y si se puede liquidar.' })
  previewLiquidacion(@Body() body: PresaleLiquidationPreviewRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<LoadGuideLiquidationPreview> {
    return this.svc.previewLiquidacion(body, query, quienPide(req));
  }

  @Post('liquidate')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: '[MCP.7] Liquida las guías de un regreso con el arqueo por denominación y devuelve el comprobante en PDF para firmar.' })
  async liquidar(@Body() body: PresaleLiquidateRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario, @Res() res: Response): Promise<void> {
    const { pdf, liquidacion } = await this.svc.liquidar(body, query, quienPide(req));
    this.enviarPdf(res, pdf, liquidacion.folio);
  }

  @Post('liquidations/:id/print')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: '[MCP.7] Reimprime el comprobante de una liquidación, marcado REIMPRESIÓN.' })
  async reimprimirLiquidacion(@Param('id') id: string, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario, @Res() res: Response): Promise<void> {
    const { pdf, liquidacion } = await this.svc.reimprimirLiquidacion(id, query, quienPide(req));
    this.enviarPdf(res, pdf, liquidacion.folio);
  }

  private enviarPdf(res: Response, pdf: Buffer, folio: string): void {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${folio}.pdf"`);
    res.setHeader('X-Liquidacion-Folio', folio);
    res.setHeader('Access-Control-Expose-Headers', 'X-Liquidacion-Folio');
    res.end(pdf);
  }

  @Post(':id/return')
  @RequirePermissions(Permission.PREVENTA_GUIAS_GESTIONAR)
  @ApiOperation({ summary: 'Registra que un pedido de una guía impresa regresó sin entregarse (con motivo): queda libre para salir otro día.' })
  regreso(@Param('id') id: string, @Body() body: PresaleReturnRequest, @Query() query: Record<string, unknown>, @Req() req: ReqUsuario): Promise<LoadGuidesResponse> {
    return this.svc.regreso(id, body?.order_id, body?.reason, query, quienPide(req));
  }
}
