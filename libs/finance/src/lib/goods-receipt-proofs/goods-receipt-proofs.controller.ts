import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, parseScopeParam } from '@megadulces/platform-core';
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
  @ApiOperation({
    summary: 'Lista órdenes de entrada de Kepler + estado de su remisión + KPIs. Scopeada por alcance (ADR-050), paginada y ordenable por antigüedad/riesgo.',
  })
  list(@Query() query: Record<string, unknown>) {
    // `warehouse_codes` es el nombre canónico ([ID.5]); los 8 alias viejos (`sucursal`,
    // `warehouse_code`, `branch`…) siguen funcionando y se loguean como deprecados.
    const { values: warehouse_codes } = parseScopeParam(query, 'warehouse', 'GET /finance/goods-receipts');
    const q: ListReceiptsQuery = {
      estado: query['estado'] as string,
      from: query['from'] as string,
      to: query['to'] as string,
      search: query['search'] as string,
      limit: query['limit'] ? Number(query['limit']) : undefined,
      warehouse_codes,
      dias_min: query['dias_min'] ? Number(query['dias_min']) : undefined,
      carril: query['carril'] as ListReceiptsQuery['carril'],
      orden: query['orden'] as ListReceiptsQuery['orden'],
      page: query['page'] ? Number(query['page']) : undefined,
      pageSize: query['pageSize'] ? Number(query['pageSize']) : undefined,
    };
    return this.svc.listReceipts(q);
  }

  @Get('coverage')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({
    summary: 'RE.13.4 — cobertura por sucursal: % con evidencia, % validadas, $ pendiente, atrasadas y antigüedad p50/p90 de lo pendiente. Respeta el alcance. El rezago (previo al arranque) va aparte.',
  })
  coverage(@Query() query: Record<string, unknown>) {
    const { values: warehouse_codes } = parseScopeParam(query, 'warehouse', 'GET /finance/goods-receipts/coverage');
    return this.svc.coverage({
      warehouse_codes,
      from: query['from'] as string,
      to: query['to'] as string,
    });
  }

  @Get('settings')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'Parámetros vigentes del proceso: arranque, tolerancia del cuadre, SLA y tope de lote.' })
  settings() {
    return this.svc.getSettings();
  }

  @Get('match')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'FOTO-PRIMERO: dado el OCR de la Aplica Orden Entrada (folio/total) o un texto, devuelve las entradas candidatas para enlazar la evidencia.' })
  match(@Query('folio') folio?: string, @Query('total') total?: string, @Query('fecha') fecha?: string, @Query('search') search?: string) {
    return this.svc.matchByOcr({ folio, total: total ? Number(total) : undefined, fecha, search });
  }

  @Get('twins')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({
    summary: 'RE.14 — pares de la MISMA recepción capturada dos veces (sucursal + oficinas 00): folio e importe de cada lado, regla y score del apareo. `estado=propuesto` = los que esperan dictamen y por eso siguen contándose dos veces.',
  })
  twins(@Query() query: Record<string, unknown>) {
    const { values: warehouse_codes } = parseScopeParam(query, 'warehouse', 'GET /finance/goods-receipts/twins');
    return this.svc.twins({
      estado: query['estado'] as 'propuesto' | 'vigente' | 'todos',
      search: query['search'] as string,
      limit: query['limit'] ? Number(query['limit']) : undefined,
      warehouse_codes,
    });
  }

  // OJO con el orden: esta ruta va ANTES de `:sucursal/:folio`, o Nest resolvería
  // `twins/<folio>/decide` como el detalle de la sucursal "twins".
  @Post('twins/:cedis_folio/decide')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'RE.14 — dictamina un par: confirmar (es la misma recepción → deja de contarse dos veces) o rechazar (es compra propia de oficinas → vuelve a contarse y el detector no la repropone). Firmado.',
  })
  decideTwin(@Param('cedis_folio') cedisFolio: string, @Body() body: { decision?: 'confirmar' | 'rechazar' }, @Req() req: AuthedRequest) {
    return this.svc.decideTwin(cedisFolio, body?.decision as 'confirmar' | 'rechazar', req?.user?.full_name || req?.user?.username);
  }

  @Get(':sucursal/:folio')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'Detalle de la entrada + sus remisiones adjuntas. Acepta el folio de OFICINAS (00): si es espejo, devuelve la canónica de sucursal + `redirigido_de`.' })
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

  @Post('attach-bulk')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({
    summary: 'RE.13.3 — adjunta VARIOS expedientes (captura por lote de CEDIS). Cada uno en su propia transacción: un duplicado en el archivo 12 no tira los 11 anteriores. Devuelve el resultado por expediente.',
  })
  attachBulk(@Body() body: { items?: AttachReceiptDto[] }, @Req() req: AuthedRequest) {
    return this.svc.attachBulk(body?.items || [], req?.user?.full_name || req?.user?.username);
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

  @Post('validate-bulk')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'RE.13.2 — valida varias evidencias de una pasada, sólo el caso limpio (cuadra al peso + no la subió el propio revisor). El server revalida cada id y devuelve qué se omitió y por qué.',
  })
  validateBulk(@Body() body: { ids?: string[] }, @Req() req: AuthedRequest) {
    return this.svc.validateBulk(body?.ids || [], req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({ summary: 'Valida la evidencia de la entrada. Auditado. Permiso especial COMPRAS_ENTRADAS_VALIDAR.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'Rechaza la evidencia con motivo TIPIFICADO (ilegible|no_corresponde|total_no_cuadra|falta_hoja|duplicada|otro) + texto. Auditado + historial.',
  })
  reject(@Param('id') id: string, @Body() body: { motivo?: string; motivo_codigo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo, body?.motivo_codigo);
  }
}
