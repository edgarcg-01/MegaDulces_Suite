import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  CommercialQuotesService,
  ListQuotesQuery,
  QuoteOrigin,
  WholesaleCustomerRow,
  QuoteCatalogRow,
  CreatedQuote,
} from './commercial-quotes.service';
import {
  QuotePricingService,
  PricedLine,
  Rung,
  AddLineResult,
  RemoveLineResult,
} from './quote-pricing.service';

/**
 * `[E.12]` — Cotizaciones de mayoreo.
 *
 * Autorización: leer exige `COMMERCIAL_QUOTES_VER`; crear/cerrar exige
 * `COMMERCIAL_QUOTES_GESTIONAR`. Son un par PROPIO, no derivado de
 * `COMMERCIAL_TELEVENTA_*`: trabajar la cola de llamadas y tener autorizado mover precio son
 * dos permisos distintos, y el `RolesGuard` es exact-key (no hay herencia entre hermanos).
 */
@ApiTags('commercial-quotes')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/quotes')
export class CommercialQuotesController {
  constructor(
    private readonly service: CommercialQuotesService,
    private readonly pricing: QuotePricingService,
  ) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Mesa de cotizaciones: folio, destinatario, vigencia, total y cuántos renglones quedaron sin casar con el catálogo.',
  })
  @ApiQuery({ name: 'status', required: false, description: 'Uno o varios separados por coma.' })
  @ApiQuery({ name: 'origin', required: false })
  @ApiQuery({ name: 'customer_id', required: false })
  @ApiQuery({ name: 'mine', required: false, type: Boolean })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  list(@Query() q: Record<string, string>) {
    const query: ListQuotesQuery = {
      status: q['status'],
      origin: q['origin'],
      customer_id: q['customer_id'],
      mine: q['mine'] === 'true' || q['mine'] === '1',
      search: q['search'],
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
    };
    return this.service.list(query);
  }

  @Get('wholesale-customers')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Padrón de clientes de MAYOREO (C####) derivado de kepler_ods.kdud, con sus condiciones POR SUCURSAL.',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Código o nombre. Vacío = primeros N.' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  searchWholesaleCustomers(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ): Promise<WholesaleCustomerRow[]> {
    return this.service.searchWholesaleCustomers(search ?? '', limit ? Number(limit) : 20);
  }

  /**
   * ⚠️ Va **antes** de `@Get(':id')`. Nest resuelve por orden de declaración: abajo de la ruta
   * paramétrica, `catalog` entraría como si fuera un id de cotización y devolvería 404/500.
   */
  @Get('catalog')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Qué se puede cotizar en una sucursal: SKU, nombre, gramaje, código de barras y unidad base, ' +
      'derivado de analytics.v_label_prices — la MISMA fuente con la que se preci­a.',
  })
  @ApiQuery({ name: 'branch', required: true, description: 'Sucursal Kepler. Sin ella no hay precio.' })
  @ApiQuery({ name: 'search', required: false, description: 'SKU, código de barras o nombre. Vacío = primeros N.' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  searchCatalog(
    @Query('branch') branch: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ): Promise<QuoteCatalogRow[]> {
    return this.service.searchCatalog(branch, search ?? '', limit ? Number(limit) : 30);
  }

  @Get('salespersons')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary: 'Lista los vendedores de Kepler asignados a la sucursal (?branch=01).',
  })
  @ApiQuery({ name: 'branch', required: true, description: 'Sucursal Kepler (01-08).' })
  salespersons(@Query('branch') branch: string): Promise<Array<{ code: string; name: string }>> {
    return this.service.listSalespersons(branch);
  }

  /**
   * `[COT.19]` Las sucursales con las que este usuario puede cotizar y en cuál arranca. ⚠️ Antes
   * de `@Get(':id')`, por la misma razón que `summary`.
   */
  @Get('branches')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Sucursales del usuario para cotizar (alcance ADR-050, área televenta): null = todas, [] = ninguna; default_branch = la de su perfil si está permitida.',
  })
  branches(): ReturnType<CommercialQuotesService['myBranches']> {
    return this.service.myBranches();
  }

  @Get('summary')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Conteos por estado + monto abierto + las que vencen pronto y las que ya vencieron sin cerrarse.',
  })
  @ApiQuery({ name: 'mine', required: false, type: Boolean })
  summary(@Query('mine') mine?: string) {
    return this.service.summary(mine === 'true' || mine === '1');
  }

  @Get('price-preview')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({ summary: 'Vista previa de precio vía GET' })
  pricePreviewGet(
    @Query('branch') branch: string,
    @Query('sku') sku: string,
    @Query('quantity') quantity: string,
    @Query('rung') rung?: Rung,
  ): Promise<PricedLine> {
    return this.pricing.previewLine({
      branch,
      sku,
      quantity: Number(quantity) || 1,
      rung,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({ summary: 'Cabecera + renglones de una cotización (descuento derivado por renglón).' })
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      'Crea la cotización en borrador con su folio COT-YYYY-NNNNN. Los renglones se cargan después.',
  })
  create(
    @Body()
    body: {
      customer_id?: string;
      /** Cliente de mayoreo del ERP (`C####`). Exige `source_branch`. */
      erp_customer_code?: string;
      source_branch?: string;
      contact_name?: string;
      contact_phone?: string;
      contact_email?: string;
      origin?: QuoteOrigin;
      warehouse_id?: string;
      price_list_id?: string;
      valid_until?: string;
      customer_request?: string;
      notes?: string;
      internal_notes?: string;
    },
  ): Promise<CreatedQuote> {
    return this.service.create(body);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      'Cancela la cotización (baja nuestra). NO es lo mismo que rechazada, que es el no del cliente.',
  })
  cancel(@Param('id') id: string, @Body() body: { reason: string }) {
    return this.service.cancel(id, body?.reason);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // `[COT.1]` El motor de precio
  //
  // ⛔ Ninguno de estos endpoints acepta un precio ni un descuento del request. El cliente dice
  // QUÉ y CUÁNTO; el precio lo deriva el servidor de los mecanismos que el ERP autoriza. Un
  // `unit_price` en el body sería la puerta trasera para regalar margen sin que nadie lo vea.
  // Y es lo que deja el módulo listo para que mañana lo opere un agente: la misma llamada.
  // ─────────────────────────────────────────────────────────────────────────────────────────

  @Post('price-preview')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_VER)
  @ApiOperation({
    summary:
      'Cotiza un renglón SIN guardarlo: devuelve el precio y el desglose completo de cómo se llegó a él (lista → volumen → promo), más lo que NO se aplicó y por qué. Es lo que la pantalla usa para mostrar el precio antes de agregar, y lo que consumirá el agente.',
  })
  pricePreview(
    @Body() body: { branch: string; sku: string; quantity: number; rung?: Rung },
  ): Promise<PricedLine> {
    return this.pricing.previewLine(body);
  }

  @Post(':id/lines')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      'Agrega un renglón a una cotización en borrador. El precio lo calcula el servidor. Si el ERP regala producto por esa cantidad, nace también el renglón hijo a precio cero. Un SKU que no casa con el catálogo se guarda como texto: es demanda que estamos rechazando, no basura.',
  })
  addLine(
    @Param('id') id: string,
    @Body() body: { sku?: string; requested_text?: string; quantity: number; rung?: Rung },
  ): Promise<AddLineResult> {
    return this.pricing.addLine(id, body);
  }

  @Patch(':id/lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary:
      'Corrige la cantidad (y opcionalmente el peldano) de un renglon, CONSERVANDO su lugar en la '
      + 'lista. ⭐ Vuelve a correr el motor: a diferencia de un pedido, en una cotizacion subir la '
      + 'cantidad puede cruzar el umbral de volumen o activar una promo del ERP, y el precio nuevo '
      + 'es justamente lo que el operador necesita ver. El precio sigue saliendo del servidor: el '
      + 'body dice cuanto, nunca a cuanto.',
  })
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: { quantity: number; rung?: Rung },
  ): Promise<AddLineResult> {
    return this.pricing.updateLine(id, lineId, body);
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_QUOTES_GESTIONAR)
  @ApiOperation({
    summary: 'Quita un renglón de una cotización en borrador. Se lleva a sus renglones de regalo.',
  })
  removeLine(@Param('id') id: string, @Param('lineId') lineId: string): Promise<RemoveLineResult> {
    return this.pricing.removeLine(id, lineId);
  }
}
