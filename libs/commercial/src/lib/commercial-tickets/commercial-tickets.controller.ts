import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RolesGuard, RequirePermissions, Permission, ScopeService, CANONICAL_PARAM } from '@megadulces/platform-core';
import { CommercialTicketsService, TicketDetalle } from './commercial-tickets.service';
import { CustomerReportService, ReporteFiltros } from './customer-report.service';
import { TicketCartaService } from './ticket-carta.service';
import { BandejaTicketsService } from './bandeja-tickets.service';
import { CommercialSalesDocumentsService } from '../commercial-sales-documents/commercial-sales-documents.service';

/**
 * Fase TK.1 — Tickets de venta. Lectura sobre vistas en vivo de `kepler_ods` + la tabla propia
 * de pedidos. No escribe nada: reimprimir un ticket no cambia una venta.
 *
 * Gateado con `COMMERCIAL_TICKETS_VER`, permiso PROPIO de esta superficie aunque se reparta
 * calcando a `COMMERCIAL_SALES_DOCS_VER`: aquel alcanza sólo telemarketing y éste además el
 * mostrador. Compartirlos haría imposible dar uno sin el otro — el error que AX ya pagó al
 * nacer reusando `COMMERCIAL_ORDERS_VER`. Reparto en la mig 20260918160200.
 */
@ApiTags('commercial-tickets')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/tickets')
export class CommercialTicketsController {
  constructor(
    private readonly svc: CommercialTicketsService,
    private readonly carta: TicketCartaService,
    private readonly reporte: CustomerReportService,
    private readonly scope: ScopeService,
    private readonly bandejaSvc: BandejaTicketsService,
    private readonly docs: CommercialSalesDocumentsService,
  ) {}

  /**
   * `[TK.13]` La razón social del EMISOR para el encabezado del ticket, de `fiscal.issuer_config`
   * (nunca de una constante: el anexo ya pagó por tenerla escrita a mano, AX.10). Si no hay
   * identidad configurada viaja `null` y el ticket la omite: reimprimir no se bloquea por eso,
   * pero tampoco se inventa un nombre.
   */
  private async conEmisor<T extends object>(doc: T): Promise<T & { emisor_nombre: string | null }> {
    const emisor = await this.docs.emisorFiscal().catch(() => null);
    return { ...doc, emisor_nombre: emisor?.nombre ?? null };
  }

  /**
   * Alcance de sucursal (GT.11 / ADR-050). Que la búsqueda no se limite POR CANAL —que es lo
   * que se pidió— no la exime de respetar a qué plazas alcanza quien pregunta. Va en el
   * controller y no en la pantalla: el endpoint recibe folios de quien sea, y un recorte que
   * sólo vive en el front no es un recorte.
   */
  private async alcance(raw: Record<string, unknown> | undefined, ruta: string): Promise<string[] | null> {
    return this.scope.readParam(raw, 'warehouse', `commercial/tickets/${ruta}`);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_TICKETS_VER)
  @ApiQuery({ name: 'q', required: true, description: 'Folio a buscar. Acepta el número suelto (18665), con ceros (0018665), la identidad completa (03UD1001-0018665) o un pedido propio (PD-2026-00012).' })
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV de sucursales. Se recorta a tu alcance.' })
  @ApiOperation({ summary: 'Busca un folio en los TRES universos de venta (mostrador U/D/10, telemarketing y crédito U/D/8-12, y pedidos propios PD-). Devuelve CANDIDATOS: el folio no identifica un documento —cada sucursal y cada caja tienen su propio contador— así que quien elige es el humano.' })
  // El documento embebido lleva además `emisor_nombre`: sigue siendo un TicketDetalle.
  async buscar(@Query() raw: Record<string, string>): Promise<Awaited<ReturnType<CommercialTicketsService['buscar']>>> {
    const r = await this.svc.buscar(raw.q, await this.alcance(raw, 'buscar'));
    return 'documento' in r && r.documento ? { ...r, documento: await this.conEmisor(r.documento) } : r;
  }

  /** TK.12 — La bandeja: lo que existe en (sucursal, rango, cliente). Va ANTES de ':id'. */
  @Get('bandeja')
  @RequirePermissions(Permission.COMMERCIAL_TICKETS_VER)
  @ApiQuery({ name: 'date_from', required: false, description: 'AAAA-MM-DD. Sin fechas = hoy (MX).' })
  @ApiQuery({ name: 'date_to', required: false, description: 'AAAA-MM-DD. Rango máximo 31 días.' })
  @ApiQuery({ name: 'cliente', required: false, description: 'Clave de cliente exacta.' })
  @ApiQuery({ name: 'q', required: false, description: 'Folio (contiene), clave de cliente (empieza con) o nombre (contiene, sin acentos).' })
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV de sucursales. Se recorta a tu alcance.' })
  @ApiOperation({ summary: 'Lista los documentos de los tres universos (mostrador, telemarketing/crédito, pedidos) de un rango de fechas y las sucursales que alcanzas. Sin ORDER BY en el ERP: si un universo llega al tope, la respuesta lo DECLARA (`truncado`).' })
  async bandeja(@Query() raw: Record<string, string>): ReturnType<BandejaTicketsService['listar']> {
    return this.bandejaSvc.listar(
      { from: raw.date_from || undefined, to: raw.date_to || undefined, cliente: raw.cliente || undefined, q: raw.q || undefined },
      await this.alcance(raw, 'bandeja'),
    );
  }

  // Antes de ':id' — si no, la ruta genérica se traga '/:id/carta.pdf'.
  @Get(':id/carta.pdf')
  @RequirePermissions(Permission.COMMERCIAL_TICKETS_VER)
  @ApiOperation({ summary: 'El mismo ticket en tamaño CARTA (PDF). Mismos datos y misma cascada de descuento que el ticket térmico, en la maqueta de los demás documentos de la suite. NO es comprobante fiscal.' })
  async cartaPdf(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const doc = await this.svc.detalle(id, await this.alcance(undefined, 'carta'));
    const pdf = await this.carta.pdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    // inline: el caso normal es verlo e imprimirlo, no bajarlo.
    res.setHeader('Content-Disposition', `inline; filename="ticket-${doc.id}.pdf"`);
    res.end(pdf);
  }

  /**
   * TK.8 — Reporte por cliente. Va ANTES de ':id' (si no, 'clientes' entraría como un folio).
   */
  @Get('clientes')
  @RequirePermissions(Permission.COMMERCIAL_TICKETS_VER)
  @ApiQuery({ name: 'q', required: true, description: 'Nombre o clave del cliente (mínimo 2 caracteres).' })
  @ApiOperation({ summary: 'Busca clientes en el MAESTRO de Kepler (kdud), no en los documentos. Excluye CONTADO y las cuentas internas: el mostrador es anónimo en el 97% de los tickets y esas claves no son de nadie. Devuelve (sucursal, clave), porque 29 de 1,005 claves nombran a un cliente distinto según la plaza.' })
  async clientes(@Query() raw: Record<string, string>): ReturnType<CustomerReportService['clientes']> {
    return this.reporte.clientes(raw.q, await this.alcance(raw, 'clientes'));
  }

  @Get('clientes/:code/reporte')
  @RequirePermissions(Permission.COMMERCIAL_TICKETS_VER)
  @ApiQuery({ name: 'date_from', required: false })
  @ApiQuery({ name: 'date_to', required: false })
  @ApiQuery({ name: 'folio', required: false, description: 'Folio o parte de el. Es "contiene": el folio no identifica un documento.' })
  @ApiQuery({ name: 'min', required: false, description: 'Importe minimo del documento.' })
  @ApiQuery({ name: 'max', required: false, description: 'Importe maximo del documento.' })
  @ApiQuery({ name: CANONICAL_PARAM.warehouse, required: false, description: 'Sucursal o CSV de sucursales. ScopeService lo interseca con tu alcance: no es un filtro aparte.' })
  @ApiQuery({ name: 'caja', required: false, description: '⚠️ Solo existe en mostrador: filtrar por caja deja fuera facturas y notas de credito.' })
  @ApiQuery({ name: 'atendio', required: false, description: 'Clave de quien atendio: cajero en mostrador, vendedor en facturas.' })
  @ApiQuery({ name: 'brand_id', required: false, description: 'El documento entra COMPLETO si alguna partida es de esa marca.' })
  @ApiQuery({ name: 'supplier_id', required: false, description: '⚠️ Solo alcanza al 84.2% del catalogo: 1,777 productos no tienen proveedor.' })
  @ApiQuery({ name: 'detalle', required: false, description: '[TK.11] true = trae las partidas de cada documento. Alarga el papel.' })
  @ApiQuery({ name: 'solo_con_descuento', required: false })
  @ApiOperation({ summary: 'Los documentos de UN cliente en TODAS las plazas que alcanzas, de los dos universos (mostrador y facturas/credito/notas). La clave de cliente es global: el catalogo esta replicado en las nueve sucursales (1,862 de 2,395 claves existen en las nueve), asi que la sucursal es un filtro, no parte de la identidad. Las notas de credito entran en NEGATIVO para que el total sea lo que el cliente pago.' })
  async reporteCliente(
    @Param('code') code: string,
    @Query() raw: Record<string, string>,
  ): ReturnType<CustomerReportService['reporte']> {
    const n = (v: string | undefined) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const f: ReporteFiltros = {
      from: raw.date_from || undefined,
      to: raw.date_to || undefined,
      folio: raw.folio || undefined,
      min: n(raw.min),
      max: n(raw.max),
      caja: n(raw.caja),
      atendio: raw.atendio || undefined,
      brand_id: raw.brand_id || undefined,
      supplier_id: raw.supplier_id || undefined,
      solo_con_descuento: raw.solo_con_descuento === 'true',
      // [TK.11] Igual que `solo_con_descuento`: SOLO el literal 'true' lo prende.
      detalle: raw.detalle === 'true',
    };
    return this.reporte.reporte(code, f, await this.alcance(raw, 'reporte'));
  }

  // Declarada AL FINAL: si fuera antes, ':id' se tragaría cualquier ruta hermana que se agregue.
  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_TICKETS_VER)
  @ApiOperation({ summary: 'Documento completo: renglones con precio de lista y precio pagado, más la cascada (lista → descuento en precio → descuento del documento → total). Es lo que consumen los dos formatos imprimibles.' })
  async detalle(@Param('id') id: string): Promise<TicketDetalle & { emisor_nombre: string | null }> {
    return this.conEmisor(await this.svc.detalle(id, await this.alcance(undefined, 'detalle')));
  }
}
