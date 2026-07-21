import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ExpenseProofsService, CreateExpenseProofDto, ListExpenseProofsQuery } from './expense-proofs.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

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
    @Query('limit') limit?: string,
  ) {
    const q: ListExpenseProofsQuery = { status, folio_solicitud, search, from, to, limit: limit ? Number(limit) : undefined };
    return this.svc.list(q);
  }

  @Get('departamentos')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Catálogo canónico de departamentos (dimensión dpto del ERP, deduplicada).' })
  departamentos() {
    return this.svc.departamentos();
  }

  @Get('status-by-folio')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: '(C) Mapa folio_solicitud → estado, para el indicador en Solicitudes.' })
  statusByFolio() {
    return this.svc.statusByFolio();
  }

  @Post('upload')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Sube UN archivo (comprobante/solicitud/evidencia) a Cloudinary y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || '');
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
