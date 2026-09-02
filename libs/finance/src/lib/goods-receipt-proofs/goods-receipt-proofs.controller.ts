import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, parseScopeParam } from '@megadulces/platform-core';
import { GoodsReceiptProofsService, ListReceiptsQuery, AttachReceiptDto, ReceiptSettings } from './goods-receipt-proofs.service';
import { GoodsReceiptTwinsService } from './goods-receipt-twins.service';
import { RemisionLine } from '@megadulces/platform-core';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * Fase CC (extensión) — Comprobantes de Orden de Entrada. Lista las órdenes de
 * entrada de Kepler (X-A-40) y les adjunta la remisión/factura del proveedor
 * (**sólo PDF** desde 2026-08-27) con OCR. Captura/adjunto a nivel VER (el capturista); validación/
 * rechazo a nivel VALIDAR (permiso especial restringido — que no todos validen).
 * No escribe a Kepler.
 */
@ApiTags('finance-goods-receipt-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/goods-receipts')
export class GoodsReceiptProofsController {
  constructor(
    private readonly svc: GoodsReceiptProofsService,
    private readonly twins: GoodsReceiptTwinsService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({
    summary: 'Lista órdenes de entrada de Kepler + estado de su remisión + KPIs. Scopeada por alcance (ADR-050), paginada y ordenable por fecha/proveedor/monto/riesgo (`orden` + `dir`).',
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
      // `[RE.25]` El cuadre del documento. Lista blanca: un valor inventado no puede
      // convertirse en un `WHERE` que no matchea nada y se lea como "no hay resultados".
      cuadre: ['cuadra', 'revisar', 'sin_datos', 'sin_evidencia'].includes(String(query['cuadre']))
        ? (query['cuadre'] as ListReceiptsQuery['cuadre'])
        : undefined,
      carril: query['carril'] as ListReceiptsQuery['carril'],
      orden: query['orden'] as ListReceiptsQuery['orden'],
      // RE.20.2 — sólo pasan los dos literales: cualquier otra cosa cae al default de la clave.
      dir: query['dir'] === 'asc' ? 'asc' : query['dir'] === 'desc' ? 'desc' : undefined,
      // RE.20.1 — el lente. `dinero` es el que absorbió a Compras 360; cualquier otra cosa
      // cae en `proceso`, que es el default y no paga el join de ajustes.
      lente: query['lente'] === 'dinero' ? 'dinero' : 'proceso',
      ajuste: query['ajuste'] as ListReceiptsQuery['ajuste'],
      con_oc: query['con_oc'] as ListReceiptsQuery['con_oc'],
      page: query['page'] ? Number(query['page']) : undefined,
      pageSize: query['pageSize'] ? Number(query['pageSize']) : undefined,
    };
    return this.svc.listReceipts(q);
  }

  // Ruta literal: va ANTES de `:sucursal/:folio` o Nest la resolvería como un detalle.
  @Get('aging')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({
    summary: 'RE.3 — QUÉ VENCE (calendario de pago), NO cuentas por pagar. Devuelve sólo lo que todavía no vence, porque no existe la liga recepción→pago: `erp_supplier_payments` no trae folio de entrada y `expense_doc_chain` está vacía, así que NO se puede saber qué ya se pagó. Lo vencido va como número declarado (`vencido_sin_confirmar`) y SIN lista: listarlo mandaría a cobrar facturas ya pagadas. Params: warehouse_codes, dias (ventana, default 30, máx 90).',
  })
  aging(
    @Query('warehouse_codes') warehouse_codes?: string,
    @Query('dias') dias?: string,
  ) {
    return this.svc.aging({
      warehouse_codes: warehouse_codes ? warehouse_codes.split(',').map((s) => s.trim()).filter(Boolean) : null,
      dias: dias ? Number(dias) : undefined,
    });
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

  @Put('settings')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'Guarda los parámetros del proceso (arranque, tolerancia del cuadre, SLA, tope de lote). Pestaña Ajustes del Centro de control. Firmado.',
  })
  saveSettings(@Body() body: Partial<ReceiptSettings>, @Req() req: AuthedRequest) {
    return this.svc.saveSettings(body || {}, req?.user?.full_name || req?.user?.username);
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
  listTwins(@Query() query: Record<string, unknown>) {
    const { values: warehouse_codes } = parseScopeParam(query, 'warehouse', 'GET /finance/goods-receipts/twins');
    return this.svc.twins({
      estado: query['estado'] as 'propuesto' | 'vigente' | 'todos',
      search: query['search'] as string,
      limit: query['limit'] ? Number(query['limit']) : undefined,
      warehouse_codes,
    });
  }

  @Post('twins/scan')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'RE.14.6 — corre el motor de apareo AHORA para este tenant (el cron ya lo hace cada 5 min). Devuelve pares nuevos, propuestas y obsoletas limpiadas.',
  })
  scanTwins() {
    return this.twins.pairNow();
  }

  // OJO con el orden: igual que `decide`, va ANTES de `:sucursal/:folio`.
  @Get('twins/:cedis_folio/lines')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({
    summary: 'RE.17.3 — renglones de los DOS lados del par (sucursal y oficinas). Es la evidencia que decide si son la misma compra: la copia de sucursal lista productos, la de oficinas suele traer un renglón de concepto.',
  })
  twinLines(@Param('cedis_folio') cedisFolio: string) {
    return this.svc.twinLines(cedisFolio);
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

  // ── RE.20.3 — descartar una entrada que nunca va a tener factura ──────────
  // OJO con el orden: `discards` va ANTES de `:sucursal/:folio`, o Nest lo resolvería como el
  // detalle de una sucursal llamada "discards".
  @Get('discards')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({
    summary: 'RE.20.3 — cuántas entradas se descartaron por sucursal y motivo. El descarte sale del denominador de cobertura, así que el conteo tiene que ser visible: si nadie lo mira, descartar es el camino corto al 100%.',
  })
  descartes(@Query() query: Record<string, unknown>) {
    const { values: warehouse_codes } = parseScopeParam(query, 'warehouse', 'GET /finance/goods-receipts/discards');
    return this.svc.descartes({ warehouse_codes });
  }

  @Post(':sucursal/:folio/discard')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'RE.20.3 — saca del proceso una entrada que NUNCA va a tener factura de proveedor (traspaso · cancelada_erp · duplicada · sin_costo · otro). Lo decide _VALIDAR y no _GESTIONAR: si el que tiene que subir pudiera declarar que no hace falta, la cobertura sería autoevaluación. Firmado.',
  })
  descartar(
    @Param('sucursal') sucursal: string, @Param('folio') folio: string,
    @Body() body: { motivo_codigo?: string; motivo?: string }, @Req() req: AuthedRequest,
  ) {
    return this.svc.descartar(sucursal, folio, body?.motivo_codigo || '', body?.motivo,
      req?.user?.full_name || req?.user?.username);
  }

  @Delete(':sucursal/:folio/discard')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VALIDAR)
  @ApiOperation({
    summary: 'RE.20.3 — deshace el descarte y la entrada vuelve al proceso (pasa: se descarta como traspaso y después aparece la factura). Las dos decisiones quedan en el historial append-only.',
  })
  reactivar(@Param('sucursal') sucursal: string, @Param('folio') folio: string, @Req() req: AuthedRequest) {
    return this.svc.reactivar(sucursal, folio, req?.user?.full_name || req?.user?.username);
  }

  @Get(':sucursal/:folio')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_VER)
  @ApiOperation({ summary: 'Detalle de la entrada + sus remisiones adjuntas. Acepta el folio de OFICINAS (00): si es espejo, devuelve la canónica de sucursal + `redirigido_de`.' })
  detail(@Param('sucursal') sucursal: string, @Param('folio') folio: string) {
    return this.svc.detail(sucursal, folio);
  }

  @Post('ocr')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'Corre OCR sobre una hoja (sólo PDF), devuelve los campos + hash + si es duplicada (misma hoja o folio ya subido). Preview, no guarda.' })
  ocr(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.runOcr(body?.file_base64 || '', body?.role);
  }

  @Post('upload')
  @RequirePermissions(Permission.COMPRAS_ENTRADAS_GESTIONAR)
  @ApiOperation({ summary: 'Sube la remisión/factura (sólo PDF) al bucket privado y devuelve su referencia (KEY, se firma al leer).' })
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
