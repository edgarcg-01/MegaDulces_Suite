import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ExpenseComprobacionesService, CreateComprobacionDto, ListComprobacionesQuery, ListGastosQuery } from './expense-comprobaciones.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * GX.8 — Comprobación de Gastos. Captura la comprobación de un gasto (ligada al
 * Folio del Gasto Kepler XA1001) con su archivo, y la valida. Captura a nivel
 * FINANCE_EXPENSES_VER (Tesorería); validación/rechazo a FINANCE_FINDINGS_GESTIONAR
 * (el contador). No escribe a Kepler.
 */
@ApiTags('finance-expense-comprobaciones')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/comprobaciones')
export class ExpenseComprobacionesController {
  constructor(private readonly svc: ExpenseComprobacionesService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Bandeja de comprobaciones + KPIs por estado.' })
  list(
    @Query('status') status?: string,
    @Query('folio_gasto') folio_gasto?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const q: ListComprobacionesQuery = { status, folio_gasto, search, from, to, limit: limit ? Number(limit) : undefined };
    return this.svc.list(q);
  }

  @Get('gastos')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Autocomplete del Folio del Gasto (Kepler XA1001) para la captura.' })
  gastos(@Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.searchGastos(search || '', limit ? Number(limit) : 20);
  }

  @Get('gastos-list')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Lista los gastos de Kepler (XA1001) + estado de su comprobación + KPIs (vista por gasto).' })
  gastosList(
    @Query('estado') estado?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const q: ListGastosQuery = { estado, search, from, to, limit: limit ? Number(limit) : undefined };
    return this.svc.listGastos(q);
  }

  @Get('status-by-gasto')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Mapa folio_gasto → estado de la comprobación (seguimiento por gasto).' })
  statusByGasto() {
    return this.svc.statusByGasto();
  }

  @Get('status-by-solicitud')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Mapa folio_solicitud → estado de la comprobación (overlay en /finanzas/solicitudes).' })
  statusBySolicitud() {
    return this.svc.statusBySolicitud();
  }

  @Post('upload')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Sube un archivo (comprobación/evidencia) al bucket y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || 'comprobacion');
  }

  @Post('ocr')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'OCR del documento "Gastos" de Kepler (XA1001, imagen/PDF) → campos para auto-rellenar la comprobación. Preview.' })
  ocr(@Body() body: { file_base64?: string }) {
    return this.svc.runOcr(body?.file_base64 || '');
  }

  @Post('validate-photo')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Valida la FOTO/EVIDENCIA del gasto con Claude Vision contra el importe del gasto Kepler. Preview (cuadra/en revisión).' })
  validatePhoto(@Body() body: { file_base64?: string; importe?: number }) {
    return this.svc.validatePhoto(body?.file_base64 || '', Number(body?.importe) || 0);
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Alta de la comprobación (archivos ya subidos). Resuelve la solicitud del gasto.' })
  create(@Body() body: CreateComprobacionDto, @Req() req: AuthedRequest) {
    return this.svc.create(body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'Valida la comprobación. Auditado.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza la comprobación (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
