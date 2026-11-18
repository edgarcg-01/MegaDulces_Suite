import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { SupplierPaymentObligationsService, CreateSupplierObligationDto, type ResultadoCuentaAnticipo } from './supplier-payment-obligations.service';
import type { ProgramarDocumentoDto } from '@megadulces/contracts';
import type { DeudaProgramableResponse, ProgramarDocumentoResultado } from '@megadulces/contracts';
import type { AnticipoOcKeplerRow, AnticipoProveedorRow, AnticipoSolicitadoRow, AnticipoSolicitudBody } from '@megadulces/contracts';
import { PERMISOS_PEDIR_ANTICIPO, type AnticipoKeplerSinSolicitudRow, type ObligacionCancelada } from '@megadulces/contracts';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * Fase TP.1 — Compras: obligaciones a proveedor de mercancía (ADR-064). Alimenta el Calendario
 * de Pagos de Finanzas (que solo LEE de acá). Permiso propio COMPRAS_OBLIGACIONES_*.
 */
@ApiTags('commercial-supplier-payment-obligations')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/supplier-obligations')
export class SupplierPaymentObligationsController {
  constructor(private readonly svc: SupplierPaymentObligationsService) {}

  @Get()
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'Lista obligaciones a proveedor de mercancía. Filtros: status, search, dueFrom, dueTo, supplier_id, onlyCritical.' })
  list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('onlyCritical') onlyCritical?: string,
  ) {
    return this.svc.list({ status, search, dueFrom, dueTo, supplier_id, onlyCritical: onlyCritical === 'true' });
  }

  /**
   * `[PGP.6]` La deuda viva que todavía no está programada. Sólo lectura: no crea nada.
   *
   * Medido el 2026-10-22: 1,740 documentos de mercancía deben $92.8 M y **33 (2.9 % del dinero)**
   * tienen obligación. El resto no tiene cómo llegar al Calendario, y esto es ese camino.
   */
  @Get('pendiente-vivo')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'PGP.6 — documentos de Kepler con saldo vivo que todavía no son obligación del Calendario.' })
  pendienteVivo(@Query('limit') limit?: string): Promise<DeudaProgramableResponse> {
    return this.svc.listDeudaProgramable({ limit: limit ? Number(limit) : undefined });
  }

  /**
   * `[PGP.6]` Programa un documento: le crea la obligación para que el Calendario pueda darle día.
   *
   * ⭐ El importe **no viaja en el cuerpo**: se lee del pendiente vivo al crear. Mandarlo desde
   * la pantalla permitiría pagar un saldo que ya no existe.
   */
  @Post('desde-documento')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'PGP.6 — crea la obligación de un documento del pendiente vivo. El importe lo pone el ODS, no el cliente.' })
  programarDocumento(@Body() dto: ProgramarDocumentoDto, @Req() req: AuthedRequest): Promise<ProgramarDocumentoResultado> {
    return this.svc.programarDocumento(dto, req.user?.username || 'sistema');
  }

  @Get('suppliers')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'Búsqueda ligera de proveedores para el selector de la obligación nueva.' })
  searchSuppliers(@Query('search') search?: string) {
    return this.svc.searchSuppliers(search);
  }

  /**
   * `[PGP.119]` El seguimiento de los anticipos pedidos en la Suite. ⛔ Va ANTES de `:id`: Nest resuelve
   * en orden y `anticipos` entraría como si fuera un id. Mismo permiso que el submódulo de Anticipos.
   */
  @Get('anticipos')
  // `[PGP.123]` También Compras (su puerta `/compras/anticipos`): pide y sigue anticipos de mercancía.
  @RequireAnyPermission(Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'PGP.119 — anticipos pedidos en la Suite (180 días) con su pago del Calendario y el X-D-60 de Kepler con que se ligan (acreedor + sucursal + importe ±$1).' })
  listAnticipos(): Promise<AnticipoSolicitadoRow[]> {
    return this.svc.listAnticiposSolicitados();
  }

  /**
   * `[PGP.144]` El otro lado del embudo: los `X-D-60` de mercancía que Kepler tiene sin solicitud en la Suite
   * (`?dias=30|90|180`, 90 por omisión). Mismo permiso que el seguimiento. ⛔ Va ANTES de `:id`.
   */
  @Get('anticipos/kepler-sin-solicitud')
  @RequireAnyPermission(Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'PGP.144 — X-D-60 de mercancía de Kepler (30/90/180 días) que no están pareados con ninguna solicitud de anticipo de la Suite.' })
  keplerSinSolicitud(@Query('dias') dias?: string): Promise<AnticipoKeplerSinSolicitudRow[]> {
    return this.svc.anticiposKeplerSinSolicitud(dias);
  }

  /**
   * `[PGP.119]` Proveedores que pueden recibir anticipo: de mercancía (código C…) y activos.
   * `[PGP.142]` D14: pedir —y lo que el formulario lee para pedir— lo puede Compras o quien programa pagos.
   */
  @Get('anticipo/proveedores')
  // `[PGP.138]`/`[PGP.142]` Pide Compras, Dirección (ADR-120, Edgar) y quien programa pagos (D14, Francisco — contradice
  // el ADR-120; lo decide Edgar en el PR). UNA lista en el contrato, la misma que los botones.
  @RequireAnyPermission(...PERMISOS_PEDIR_ANTICIPO)
  @ApiOperation({ summary: 'PGP.119 — proveedores de mercancía activos para pedirles anticipo; busca por nombre o código.' })
  anticipoProveedores(@Query('search') search?: string): Promise<AnticipoProveedorRow[]> {
    return this.svc.anticipoProveedores(search);
  }

  /** `[PGP.127]` Las OC de Kepler (`X-A-35`) del proveedor, pendientes o parciales, con lo ya anticipado (el tope, D6). */
  @Get('anticipo/ocs')
  @RequireAnyPermission(...PERMISOS_PEDIR_ANTICIPO)
  @ApiOperation({ summary: 'PGP.127 — OC de Kepler (X-A-35) pendientes o parciales de un proveedor (180 días), su sucursal, su total y los anticipos ya pedidos sobre cada una.' })
  anticipoOcs(@Query('supplier_id') supplierId?: string): Promise<AnticipoOcKeplerRow[]> {
    return this.svc.anticipoOcs(String(supplierId ?? ''));
  }

  /** `[PGP.127]` Sube la cotización del anticipo (PDF o foto, base64, hasta 10 MB) y devuelve su llave. */
  @Post('anticipo/cotizacion')
  @RequireAnyPermission(...PERMISOS_PEDIR_ANTICIPO)
  @ApiOperation({ summary: 'PGP.127 — sube la cotización (PDF o foto) al almacenamiento privado; el pedido la cita por su llave.' })
  subirCotizacion(@Body() body: { file_base64?: string }): Promise<{ key: string; kind: 'pdf' | 'image' }> {
    return this.svc.subirCotizacion(String(body?.file_base64 ?? ''));
  }

  /** `[PGP.119]` Pide un anticipo: nace una obligación de naturaleza `anticipo` que entra al Calendario. */
  @Post('anticipo')
  @RequireAnyPermission(...PERMISOS_PEDIR_ANTICIPO)
  @ApiOperation({ summary: 'PGP.119/127 — pide un anticipo a un proveedor de mercancía con su cotización, su OC de Kepler (sin pasar de su saldo) y la cuenta a la que se paga (la CLABE nueva queda pedida de alta). Entra al Calendario; Dirección autoriza el pago.' })
  crearAnticipo(@Body() dto: AnticipoSolicitudBody, @Req() req: AuthedRequest): Promise<{ obligation_id: string; monto: number; concepto: string; cuenta: ResultadoCuentaAnticipo }> {
    return this.svc.crearAnticipo(dto, req.user?.username || 'sistema');
  }

  /**
   * `[PGP.127]` La cotización de un anticipo (URL firmada, 10 min). La abren Compras y el Calendario: los mismos
   * dos permisos que el seguimiento. ⛔ Va ANTES de `:id`.
   */
  @Get('anticipos/:id/cotizacion')
  @RequireAnyPermission(Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'PGP.127 — URL firmada (10 min) de la cotización de un anticipo pedido en la Suite.' })
  cotizacion(@Param('id') id: string): Promise<{ url: string; kind: string | null }> {
    return this.svc.cotizacionUrl(id);
  }

  /**
   * `[PGP.142]` Cancela un anticipo PEDIDO (y sólo eso): quien puede pedirlo, puede deshacerlo. El cancelar
   * genérico (`:id/cancelar`) sigue siendo sólo de Compras: cancela cualquier obligación a proveedor.
   * ⛔ Va ANTES de `:id`.
   */
  @Post('anticipos/:id/cancelar')
  @RequireAnyPermission(...PERMISOS_PEDIR_ANTICIPO)
  @ApiOperation({ summary: 'PGP.142 — cancela un anticipo pedido en la Suite que todavía no tiene pago (con razón). Sólo anticipos.' })
  cancelarAnticipo(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest): Promise<ObligacionCancelada> {
    return this.svc.cancelAnticipo(id, body?.reason, req.user?.username || 'sistema');
  }

  @Get(':id')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Captura una obligación a proveedor de mercancía. Nace autorizada (authorized_by = quien la captura).' })
  create(@Body() dto: CreateSupplierObligationDto, @Req() req: AuthedRequest) {
    return this.svc.create(dto, req.user?.username || 'sistema');
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.cancel(id, body?.reason, req.user?.username || 'sistema');
  }

  @Post('suppliers/:id/critico')
  @RequirePermissions(Permission.COMPRAS_PROVEEDORES_GESTIONAR)
  @ApiOperation({ summary: 'Marca/desmarca un proveedor como crítico — SIEMPRE con motivo, nunca inferido del importe.' })
  setCritical(@Param('id') id: string, @Body() body: { is_critical: boolean; reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.setSupplierCritical(id, !!body?.is_critical, body?.reason, req.user?.username || 'sistema');
  }
}
