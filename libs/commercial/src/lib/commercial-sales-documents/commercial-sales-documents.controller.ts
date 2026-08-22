import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialSalesDocumentsService, SalesDocsQuery } from './commercial-sales-documents.service';
import { AnexoVentaService } from './anexo-venta.service';

/**
 * AX.1 — Documentos de venta al cliente. Lectura sobre vistas en vivo de `kepler_ods`.
 * Gateado con COMMERCIAL_ORDERS_VER: quien puede ver pedidos puede ver su factura.
 */
@ApiTags('commercial-sales-documents')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/sales-documents')
export class CommercialSalesDocumentsController {
  constructor(
    private readonly svc: CommercialSalesDocumentsService,
    private readonly anexo: AnexoVentaService,
  ) {}

  private q(raw: Record<string, string | undefined>): SalesDocsQuery {
    return {
      from: raw.from, to: raw.to, warehouse_ids: raw.warehouse_ids, doc_tipo: raw.doc_tipo,
      cliente_code: raw.cliente_code, vendedor_code: raw.vendedor_code, search: raw.search,
      vencidas: raw.vencidas, min: raw.min,
      page: raw.page ? Number(raw.page) : undefined,
      pageSize: raw.pageSize ? Number(raw.pageSize) : undefined,
    };
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Facturas de venta (telemarketing / crédito) con KPIs. Filtros: from, to, warehouse_ids, doc_tipo, cliente_code, vendedor_code, min, vencidas, search (cliente/RFC/folio/monto).' })
  list(@Query() raw: Record<string, string>) { return this.svc.list(this.q(raw)); }

  @Get('filtros')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Catálogos para los filtros (vendedores, sucursales, tipos) de la ventana consultada.' })
  filtros(@Query() raw: Record<string, string>) { return this.svc.filtros(this.q(raw)); }

  // Antes de ':folio' — si no, la ruta genérica se traga '/:folio/anexo.pdf'.
  @Get(':folio/anexo.pdf')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Anexo informativo al CFDI en PDF (carta). Incluye SIEMPRE la sección de pagaré; `?pagare=false` la omite. NO es comprobante fiscal.' })
  async anexoPdf(
    @Param('folio') folio: string,
    @Query('pagare') pagare: string,
    @Res() res: Response,
  ) {
    const buf = await this.anexo.pdfDeFolio(folio, { pagare: pagare !== 'false' });
    res.setHeader('Content-Type', 'application/pdf');
    // inline: el caso normal es verlo/imprimirlo, no bajarlo.
    res.setHeader('Content-Disposition', `inline; filename="anexo-${folio}.pdf"`);
    res.end(buf);
  }

  // Declarada AL FINAL: si fuera antes, ':folio' se tragaría /filtros.
  @Get(':folio')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Documento completo (cabecera + renglones con precio de lista, precio con descuento, equivalencia en cajas y neto). Es lo que consume el anexo imprimible.' })
  detail(@Param('folio') folio: string) { return this.svc.detail(folio); }
}
