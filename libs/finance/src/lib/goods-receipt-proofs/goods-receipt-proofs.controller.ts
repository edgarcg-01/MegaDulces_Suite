import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { GoodsReceiptProofsService, ListReceiptsQuery, AttachReceiptDto } from './goods-receipt-proofs.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * Fase CC (extensión) — Comprobantes de Orden de Entrada. Lista las órdenes de
 * entrada de Kepler (X-A-40) y les adjunta la remisión/factura del proveedor
 * (imagen/PDF) con OCR. Captura/adjunto a nivel VER (el capturista); validación/
 * rechazo a nivel GESTIONAR (el revisor). No escribe a Kepler.
 */
@ApiTags('finance-goods-receipt-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/goods-receipts')
export class GoodsReceiptProofsController {
  constructor(private readonly svc: GoodsReceiptProofsService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_VER)
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

  @Get(':sucursal/:folio')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Detalle de la entrada + sus remisiones adjuntas.' })
  detail(@Param('sucursal') sucursal: string, @Param('folio') folio: string) {
    return this.svc.detail(sucursal, folio);
  }

  @Post('ocr')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Corre OCR sobre la remisión/factura (imagen/PDF) y devuelve los campos (preview, no guarda).' })
  ocr(@Body() body: { file_base64?: string }) {
    return this.svc.runOcr(body?.file_base64 || '');
  }

  @Post('upload')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Sube la remisión/factura (imagen/PDF) a Cloudinary y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || 'remision');
  }

  @Post('attach')
  @RequirePermissions(Permission.COMPRAS_VER)
  @ApiOperation({ summary: 'Adjunta la evidencia a la entrada (con archivos ya subidos + OCR). Calcula el cuadre de monto.' })
  attach(@Body() body: AttachReceiptDto, @Req() req: AuthedRequest) {
    return this.svc.attach(body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Valida la evidencia de la entrada. Auditado.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.COMPRAS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza la evidencia (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
