import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { GoodsReceiptProofsService, ListReceiptsQuery, AttachReceiptDto } from './goods-receipt-proofs.service';
import { RemisionLine } from '@megadulces/platform-core';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * Fase CC (extensión) — Comprobantes de Orden de Entrada. Lista las órdenes de
 * entrada de Kepler (X-A-40) y les adjunta la remisión/factura del proveedor
 * (imagen/PDF) con OCR. Captura/adjunto a nivel VER (el capturista); validación/
 * rechazo a nivel VALIDAR (permiso especial restringido — que no todos validen).
 * No escribe a Kepler.
 */
@ApiTags('finance-goods-receipt-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/goods-receipts')
export class GoodsReceiptProofsController {
  constructor(private readonly svc: GoodsReceiptProofsService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'Lista órdenes de entrada de Kepler + estado de su remisión + KPIs.' })
  list(
    @Query('estado') estado?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const q: ListReceiptsQuery = { estado, from, to, search, limit: limit ? Number(limit) : undefined };
    return this.svc.listReceipts(q);
  }

  @Get('match')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'FOTO-PRIMERO: dado el OCR de la Aplica Orden Entrada (folio/total) o un texto, devuelve las entradas candidatas para enlazar la evidencia.' })
  match(@Query('folio') folio?: string, @Query('total') total?: string, @Query('fecha') fecha?: string, @Query('search') search?: string) {
    return this.svc.matchByOcr({ folio, total: total ? Number(total) : undefined, fecha, search });
  }

  @Get(':sucursal/:folio')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'Detalle de la entrada + sus remisiones adjuntas.' })
  detail(@Param('sucursal') sucursal: string, @Param('folio') folio: string) {
    return this.svc.detail(sucursal, folio);
  }

  @Post('ocr')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'Corre OCR sobre una hoja (imagen/PDF), devuelve los campos + hash + si es duplicada (misma hoja o folio ya subido). Preview, no guarda.' })
  ocr(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.runOcr(body?.file_base64 || '', body?.role);
  }

  @Post('upload')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'Sube la remisión/factura (imagen/PDF) a Cloudinary y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || 'remision');
  }

  @Post('attach')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'Adjunta la evidencia a la entrada (con archivos ya subidos + OCR). Calcula el cuadre de monto.' })
  attach(@Body() body: AttachReceiptDto, @Req() req: AuthedRequest) {
    return this.svc.attach(body, req?.user?.full_name || req?.user?.username);
  }

  @Post('reconcile')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'RE.11.2 — Concilia los renglones de la remisión (OCR) contra las líneas Kepler de la entrada. Resuelve SKU (alias→barcode→descripción) + cuadra cantidad con box_factor. No guarda.' })
  reconcile(@Body() body: { sucursal?: string; folio?: string; lines?: RemisionLine[] }) {
    return this.svc.reconcileLines(body?.sucursal || '', body?.folio || '', body?.lines || []);
  }

  @Post('confirm-line')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'RE.11.4 — Aprende un match: descripción del proveedor → SKU interno (UPSERT en supplier_item_aliases). La próxima remisión del mismo proveedor lo resuelve solo.' })
  confirmLine(
    @Body() body: { proveedor_rfc?: string; descripcion?: string; sku?: string; nombre_interno?: string; unidad_proveedor?: string; box_factor?: number },
    @Req() req: AuthedRequest,
  ) {
    return this.svc.confirmLineMatch(body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({ summary: 'Valida la evidencia de la entrada. Auditado. Permiso especial COMPRAS_ENTRADAS_VALIDAR.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({ summary: 'Rechaza la evidencia (con motivo). Auditado. Permiso especial COMPRAS_ENTRADAS_VALIDAR.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
