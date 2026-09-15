import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { SupplierPaymentObligationsService, CreateSupplierObligationDto } from './supplier-payment-obligations.service';

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
