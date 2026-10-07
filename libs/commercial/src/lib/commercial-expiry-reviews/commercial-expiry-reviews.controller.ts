import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission, SpeechToTextService } from '@megadulces/platform-core';
import {
  CommercialExpiryReviewsService,
  CreateReviewDto,
  ReviewLineDto,
  ResolveResult,
  EntryDto,
} from './commercial-expiry-reviews.service';
import {
  ExpiryVoiceService,
  VoiceIntakeResult,
  VoiceSlots,
  VoiceTurn,
} from './expiry-voice.service';

/**
 * Fase P2.6 — Control de Caducidades. Lectura gateada por COMMERCIAL_EXPIRY_VER,
 * escritura/submit por COMMERCIAL_EXPIRY_CAPTURAR (permisos dedicados, ADR-022).
 *
 * **2026-09-08 — los dos permisos por fin parten dos oficios distintos.** El
 * colaborador de sucursal (solo CAPTURAR) da de alta caducidades; el encargado
 * (VER) mira el historial de SU sucursal. Eso obligó a mover tres gates que
 * mezclaban ambos roles: `resolve` y la búsqueda de producto son **captura**
 * (escanear es capturar; pedirle VER para escanear le negaba el trabajo al
 * colaborador), y el historial se filtra por alcance de sucursal en el service.
 */
@ApiTags('commercial-expiry-reviews')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/expiry-reviews')
export class CommercialExpiryReviewsController {
  constructor(
    private readonly service: CommercialExpiryReviewsService,
    private readonly voice: ExpiryVoiceService,
    private readonly stt: SpeechToTextService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Listar hojas de Control de Caducidades (paginado, filtros)' })
  list(
    @Query('warehouse_id') warehouseId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listReviews({
      warehouse_id: warehouseId,
      status,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /**
   * Va ANTES de `@Get(':id')` a propósito: Nest matchea en orden de declaración y
   * `:id` se tragaría `/resolve` como si fuera un UUID (400 'id inválido').
   */
  @Get('resolve')
  @RequireAnyPermission(Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Resolver un código (pistola/cámara/tecleado) a producto: match único o candidatos' })
  resolve(@Query('code') code?: string): Promise<ResolveResult> {
    return this.service.resolveCode(code || '');
  }

  /** Igual que `resolve`: mismo orden-antes-de-`:id`, mismo gate de captura. */
  @Get('products')
  @RequireAnyPermission(Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Buscar producto por nombre/SKU para capturar (scopeado a las marcas del promotor)' })
  searchProducts(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.service.searchProducts(q || '', limit ? Number(limit) : undefined);
  }

  // ── captura de tienda: una caducidad a la vez (2026-09-08) ──

  @Get('entries/context')
  @RequireAnyPermission(Permission.COMMERCIAL_EXPIRY_CAPTURAR, Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Dónde captura esta persona: su sucursal resuelta (o el picker, si su alcance es amplio)' })
  captureContext() {
    return this.service.captureContext();
  }

  // ── expediente: una hoja por producto, archivada por sucursal ──
  //
  // Declarados ANTES de `@Get(':id')` por el orden de matcheo de Nest, igual que
  // `resolve` y `products`.

  @Get('expediente/sucursales')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Portada del expediente: una fila por sucursal con hojas / por vencer / vencidos' })
  expedienteBranches() {
    return this.service.expedienteBranches();
  }

  @Get('expediente')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Hojas del expediente (una por producto), filtrables por sucursal / fecha / plazo / folio' })
  expediente(
    @Query('warehouse_id') warehouseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plazo') plazo?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listExpediente({
      warehouse_id: warehouseId,
      from,
      to,
      plazo,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /**
   * Una hoja para imprimir. Gate de CUALQUIERA de los dos permisos: quien
   * capturó la hoja tiene que poder imprimirla (es el papel que firma y archiva),
   * y con gate de VER el colaborador no podía ver la suya. El alcance de sucursal
   * lo aplica el service.
   */
  @Get('hoja/:folioOrId')
  @RequireAnyPermission(Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Una hoja del expediente por folio (CAD-03-2026-00001) o por id de renglón' })
  hoja(@Param('folioOrId') folioOrId: string) {
    return this.service.getHoja(folioOrId);
  }

  @Get('entries/mine')
  @RequireAnyPermission(Permission.COMMERCIAL_EXPIRY_CAPTURAR, Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Lo que YO capturé HOY (eco del turno, para revisar y corregir)' })
  myEntries(@Query('limit') limit?: string) {
    return this.service.listMyEntries(limit ? Number(limit) : undefined);
  }

  @Post('entries')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Alta de UNA caducidad en la sucursal del usuario; alimenta FEFO al guardar' })
  createEntry(@Body() body: EntryDto) {
    return this.service.createEntry(body);
  }

  @Patch('entries/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Corregir una alta propia del día (revierte y re-alimenta FEFO)' })
  updateEntry(@Param('lineId') lineId: string, @Body() body: ReviewLineDto) {
    return this.service.updateEntry(lineId, body);
  }

  @Delete('entries/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Borrar una alta propia del día (devuelve al lote NA lo fechado)' })
  deleteEntry(@Param('lineId') lineId: string) {
    return this.service.deleteEntry(lineId);
  }

  /**
   * P2.7 — asistente de voz. Recibe TEXTO (el audio lo transcribe
   * `POST /commercial/intelligence/thot/transcribe`) y devuelve los campos
   * entendidos + la siguiente pregunta. **No escribe el renglón**: prellena la
   * pantalla y la persona confirma (co-piloto, ADR-020).
   *
   * Gate de CAPTURAR y no de VER: llenar un renglón es captura, aunque el
   * guardado final sea otro click.
   */
  /**
   * Dictado: audio → texto. Endpoint PROPIO a propósito, no el de Thot
   * (`/commercial/intelligence/thot/transcribe`): ése está gateado con
   * `COMMERCIAL_ORDERS_VER` y quien captura caducidades **no lo tiene** — su rol
   * lleva `COMMERCIAL_EXPIRY_CAPTURAR` y nada de ventas. Reusarlo le daba 403 al
   * primer intento de hablar, o forzaba a repartir un permiso de ventas para
   * poder dictar. El proveedor (Groq Whisper) es el mismo servicio compartido.
   */
  @Post('voice/transcribe')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Dictado: audio base64 -> texto (Groq Whisper, es)' })
  voiceTranscribe(@Body() body: { audio?: string; mime?: string }) {
    return this.stt.transcribe(body?.audio || '', body?.mime || 'audio/webm');
  }

  @Post('voice/intake')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Asistente de voz: transcripción → campos del renglón + siguiente pregunta' })
  voiceIntake(
    @Body() body: { transcript?: string; slots?: VoiceSlots; history?: VoiceTurn[] },
  ): Promise<VoiceIntakeResult> {
    return this.voice.intake({
      transcript: body?.transcript || '',
      slots: body?.slots,
      history: Array.isArray(body?.history) ? body.history : [],
    });
  }

  /** El operador elige uno de los candidatos que ofreció el asistente. */
  @Post('voice/pick')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Asistente de voz: fijar el producto elegido entre los candidatos' })
  voicePick(@Body() body: { slots?: VoiceSlots; product_id?: string }): Promise<VoiceIntakeResult> {
    return this.voice.pickProduct(body?.slots || {}, String(body?.product_id || ''));
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Detalle de una hoja (encabezado + renglones)' })
  get(@Param('id') id: string) {
    return this.service.getReview(id);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Crear hoja (draft)' })
  create(@Body() body: CreateReviewDto) {
    return this.service.createReview(body);
  }

  @Post('upload')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Subir foto de evidencia (base64 → Cloudinary). Devuelve {url,public_id,kind}.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.service.uploadFile(body?.file_base64 || '', body?.role || 'evidencia');
  }

  @Post(':id/lines')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Agregar renglón a la hoja' })
  addLine(@Param('id') id: string, @Body() body: ReviewLineDto) {
    return this.service.addLine(id, body);
  }

  @Patch('lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Editar un renglón' })
  updateLine(@Param('lineId') lineId: string, @Body() body: ReviewLineDto) {
    return this.service.updateLine(lineId, body);
  }

  @Delete('lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Borrar un renglón' })
  deleteLine(@Param('lineId') lineId: string) {
    return this.service.deleteLine(lineId);
  }

  @Post(':id/submit')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Enviar la hoja: marca submitted y alimenta FEFO (lotes fechados en stock_lots)' })
  submit(@Param('id') id: string) {
    return this.service.submitReview(id);
  }
}
