import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { ExpenseProofsService, CreateExpenseProofDto, ListExpenseProofsQuery } from './expense-proofs.service';

interface AuthedRequest { user?: { sub?: string; username?: string; full_name?: string; role_name?: string; permissions?: Record<string, boolean> }; }

/**
 * GX.7 — Solicitud de autorización de gastos (reembolso). Captura + adjuntos
 * (cualquiera con acceso a egresos) y validación/rechazo (gestión de finanzas).
 * No escribe a Kepler.
 */
@ApiTags('finance-expense-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/proofs')
export class ExpenseProofsController {
  constructor(private readonly svc: ExpenseProofsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Lista solicitudes de reembolso + KPIs.' })
  list(
    @Query('status') status?: string,
    @Query('folio_solicitud') folio_solicitud?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('mine') mine?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    const q: ListExpenseProofsQuery = {
      status, folio_solicitud, search, from, to,
      // `mine` se resuelve del token, no de un parámetro: nadie pide "lo de otro".
      mine: mine === 'true' ? (req?.user?.full_name || req?.user?.username || '') : undefined,
      limit: limit ? Number(limit) : undefined,
    };
    return this.svc.list(q);
  }

  @Get('departamentos')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Catálogo canónico de departamentos (dimensión dpto del ERP, deduplicada).' })
  departamentos() {
    return this.svc.departamentos();
  }

  @Get('search-solicitudes')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Busca la SOLICITUD (XA1501) contra la que se sube el comprobante. Folio por valor numérico (los últimos dígitos bastan) o beneficiario. Acotado a las áreas del usuario; sin áreas, sólo folio exacto.' })
  searchSolicitudes(@Query('q') q: string, @Query('limit') limit?: string, @Req() req?: AuthedRequest) {
    return this.svc.searchSolicitudes(q, limit ? Number(limit) : undefined, req?.user);
  }

  @Get('status-by-folio')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: '(C) Mapa folio_solicitud → estado, para el indicador en Solicitudes.' })
  statusByFolio() {
    return this.svc.statusByFolio();
  }

  // Va después de las rutas GET estáticas: declarada antes, ':id' se tragaría
  // 'departamentos' y 'status-by-folio'.
  @Get(':id')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Detalle de una solicitud con los adjuntos re-firmados (para el visor de quien revisa).' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }

  @Post('upload')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Sube UN archivo (comprobante/solicitud/evidencia) al bucket y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || '');
  }

  @Post('validate-photo')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Valida la FOTO del comprobante con Claude Vision contra el importe de la solicitud. Preview (cuadra/en revisión).' })
  validatePhoto(@Body() body: { file_base64?: string; importe?: number }) {
    return this.svc.validatePhoto(body?.file_base64 || '', Number(body?.importe) || 0);
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Alta de la solicitud de reembolso (con los archivos ya subidos).' })
  create(@Body() body: CreateExpenseProofDto, @Req() req: AuthedRequest) {
    return this.svc.create(body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'Valida la solicitud de reembolso. Auditado.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza la solicitud (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
