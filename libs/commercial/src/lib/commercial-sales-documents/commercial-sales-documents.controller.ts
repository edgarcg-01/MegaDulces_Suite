import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesGuard, RequirePermissions, Permission, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
import { CommercialSalesDocumentsService, SalesDocsQuery } from './commercial-sales-documents.service';
import { AnexoVentaService } from './anexo-venta.service';
import { GuiaCobranzaService } from './guia-cobranza.service';

/**
 * AX.1 — Facturación de Telemarketing. Lectura sobre vistas en vivo de `kepler_ods`.
 *
 * Gateado con COMMERCIAL_SALES_DOCS_VER, permiso PROPIO de esta superficie.
 * Antes reusaba COMMERCIAL_ORDERS_VER ("quien ve pedidos ve su factura") y eso
 * dejaba la página fuera de `/admin/roles`: no se podía asignar sin dar Pedidos
 * ni quitar sin quitarlos. Backfill ← ORDERS_VER en `20260825120000`, salvo los
 * roles del Portal B2B: acá NO hay scoping por cliente (sólo `tenant_id`), así
 * que un `customer_b2b` vería las facturas de todos los clientes.
 */
@ApiTags('commercial-sales-documents')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/sales-documents')
export class CommercialSalesDocumentsController {
  constructor(
    private readonly svc: CommercialSalesDocumentsService,
    private readonly anexo: AnexoVentaService,
    private readonly guia: GuiaCobranzaService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * GT.11 — alcance de sucursal. `readParam` lee el nombre canónico y los alias viejos,
   * acepta código o uuid, y **recorta lo pedido a lo que el usuario alcanza** (ADR-050):
   *   - alcance `all` sin pedir nada  → `null` (sin filtro, como siempre);
   *   - alcance `all` pidiendo `03`   → sólo esa;
   *   - alcance de una sucursal       → la suya, y si pide otra se recorta en silencio.
   * Va en el controller y no en la pantalla: el endpoint recibe folios y filtros de quien
   * sea, y un recorte que sólo vive en el front no es un recorte.
   */
  private async alcance(raw: Record<string, unknown> | undefined, ruta: string) {
    return this.scope.readParam(raw, 'warehouse', `commercial/sales-documents/${ruta}`);
  }

  private q(raw: Record<string, string | undefined>): SalesDocsQuery {
    return {
      from: raw.from, to: raw.to, doc_tipo: raw.doc_tipo,
      cliente_code: raw.cliente_code, vendedor_code: raw.vendedor_code, search: raw.search,
      vencidas: raw.vencidas, cobro: raw.cobro, min: raw.min, canceladas: raw.canceladas,
      page: raw.page ? Number(raw.page) : undefined,
      pageSize: raw.pageSize ? Number(raw.pageSize) : undefined,
    };
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_SALES_DOCS_VER)
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV de sucursales. Se recorta a tu alcance. Acepta los nombres viejos (warehouse_id, sucursal, branch…) y valores en código o uuid.' })
  @ApiOperation({ summary: 'Facturas de telemarketing (U/D/8) con KPIs de cobranza, ACOTADAS a tu alcance de sucursales. Excluye las canceladas en Kepler salvo ?canceladas=true. Filtros: from, to, warehouse_codes, doc_tipo, cliente_code, vendedor_code, min, vencidas (venció Y debe), cobro (pagada|parcial|pendiente|sin_cartera), search (cliente/RFC/folio/monto).' })
  async list(@Query() raw: Record<string, string>) {
    return this.svc.list({ ...this.q(raw), warehouse_codes: await this.alcance(raw, 'list') });
  }

  @Get('filtros')
  @RequirePermissions(Permission.COMMERCIAL_SALES_DOCS_VER)
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV de sucursales. Se recorta a tu alcance.' })
  @ApiOperation({ summary: 'Catálogos para los filtros (vendedores, sucursales) de la ventana consultada, acotados a tu alcance: quien sólo alcanza una sucursal no ve al personal de las otras.' })
  async filtros(@Query() raw: Record<string, string>) {
    return this.svc.filtros({ ...this.q(raw), warehouse_codes: await this.alcance(raw, 'filtros') });
  }

  /**
   * GT.2 — Guía de Cobranza de las facturas SELECCIONADAS en pantalla.
   *
   * POST y no GET a propósito: la selección puede traer cientos de folios y no cabe en una
   * URL. Devuelve el PDF inline (el front lo trae como blob para poder mandar el JWT).
   */
  @Post('guia-cobranza.pdf')
  @RequirePermissions(Permission.COMMERCIAL_SALES_DOCS_VER)
  @ApiOperation({ summary: 'Guía de Cobranza en PDF de las facturas seleccionadas (body: { folios: string[], responsable?, nota? }). Agrupa por cliente e imprime el saldo pendiente. Documento interno, NO fiscal.' })
  async guiaCobranza(
    @Body() body: { folios?: string[]; responsable?: string; nota?: string },
    @Res() res: Response,
  ) {
    const buf = await this.guia.pdfDeFolios(body?.folios || [], {
      responsable: body?.responsable, nota: body?.nota,
      warehouse_codes: await this.alcance(undefined, 'guia-cobranza'),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="guia-cobranza.pdf"');
    res.end(buf);
  }

  // Antes de ':folio' — si no, la ruta genérica se traga '/:folio/anexo.pdf'.
  @Get(':folio/anexo.pdf')
  @RequirePermissions(Permission.COMMERCIAL_SALES_DOCS_VER)
  @ApiOperation({ summary: 'Anexo informativo al CFDI en PDF (carta). Incluye SIEMPRE la sección de pagaré; `?pagare=false` la omite. NO es comprobante fiscal.' })
  async anexoPdf(
    @Param('folio') folio: string,
    @Query('pagare') pagare: string,
    @Res() res: Response,
  ) {
    const buf = await this.anexo.pdfDeFolio(folio, {
      pagare: pagare !== 'false',
      warehouse_codes: await this.alcance(undefined, 'anexo'),
    });
    res.setHeader('Content-Type', 'application/pdf');
    // inline: el caso normal es verlo/imprimirlo, no bajarlo.
    res.setHeader('Content-Disposition', `inline; filename="anexo-${folio}.pdf"`);
    res.end(buf);
  }

  // Declarada AL FINAL: si fuera antes, ':folio' se tragaría /filtros.
  @Get(':folio')
  @RequirePermissions(Permission.COMMERCIAL_SALES_DOCS_VER)
  @ApiOperation({ summary: 'Documento completo (cabecera + renglones con precio de lista, precio con descuento, equivalencia en cajas y neto). Es lo que consume el anexo imprimible.' })
  async detail(@Param('folio') folio: string) {
    return this.svc.detail(folio, { warehouse_codes: await this.alcance(undefined, 'detail') });
  }
}
