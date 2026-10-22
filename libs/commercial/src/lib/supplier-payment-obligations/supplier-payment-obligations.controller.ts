import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { SupplierPaymentObligationsService, CreateSupplierObligationDto } from './supplier-payment-obligations.service';
import type { ProgramarDocumentoDto } from '@megadulces/contracts';
import type { DeudaProgramableResponse, ProgramarDocumentoResultado } from '@megadulces/contracts';

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
