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

  @Get('search-solicitudes')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Busca la SOLICITUD (XA1501) contra la que se sube el comprobante. Folio por valor numérico (los últimos dígitos bastan) o beneficiario. Acotado a las áreas del usuario; sin áreas, sólo folio exacto.' })
  searchSolicitudes(@Query('q') q: string, @Query('limit') limit?: string, @Req() req?: AuthedRequest) {
    return this.svc.searchSolicitudes(q, limit ? Number(limit) : undefined, req?.user);
  }

  @Get('mine')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Lo que capturó ESTE usuario. Ruta propia: abrir la bandeja completa a quien sólo captura le daría los comprobantes de toda la empresa.' })
  mine(@Query('limit') limit?: string, @Req() req?: AuthedRequest) {
    const actor = req?.user?.full_name || req?.user?.username || '';
    // Sin actor NO se cae a sin-filtro: eso devolveria la bandeja completa de la
    // empresa a quien solo captura. Se devuelve vacio.
    if (!actor) return { kpis: { total: 0, recibidas: 0, validadas: 0, rechazadas: 0, en_revision: 0 }, rows: [] };
    return this.svc.list({ mine: actor, limit: limit ? Number(limit) : undefined });
  }

  @Get('status-by-folio')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: '(C) Mapa folio_solicitud → estado, para el indicador en Solicitudes.' })
  statusByFolio() {
    return this.svc.statusByFolio();
  }

  @Get('proof-by-folio')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Estado del expediente de UN folio (para saber en qué momento está la captura). Accesible al capturista.' })
  proofByFolio(@Query('folio') folio: string) {
    return this.svc.proofByFolio(folio || '');
  }

  // Va después de las rutas GET estáticas: declarada antes, ':id' se tragaría
  // 'departamentos', 'status-by-folio' y 'proof-by-folio'.
  @Get(':id')
  @RequirePermissions(Permission.FINANCE_EXPENSES_VER)
  @ApiOperation({ summary: 'Detalle de una solicitud con los adjuntos re-firmados (para el visor de quien revisa).' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }

  @Post('upload')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Sube UN archivo (comprobante/solicitud/evidencia) al bucket y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || '');
  }

  @Post('validate-photo')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Valida la FOTO del comprobante con Claude Vision contra el importe de la solicitud. Preview (cuadra/en revisión).' })
  validatePhoto(@Body() body: { file_base64?: string; importe?: number }) {
    return this.svc.validatePhoto(body?.file_base64 || '', Number(body?.importe) || 0);
  }

  @Post()
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Alta de la solicitud de reembolso (con los archivos ya subidos).' })
  create(@Body() body: CreateExpenseProofDto, @Req() req: AuthedRequest) {
    return this.svc.create(body, req?.user?.full_name || req?.user?.username);
  }

  // MOMENTO 3 — el capturista sube la evidencia DESPUÉS de aprobar (gasto comprobable).
  @Post(':id/evidence')
  @RequireAnyPermission(Permission.FINANCE_EXPENSES_VER, Permission.FINANCE_EXPENSES_CAPTURAR)
  @ApiOperation({ summary: 'Sube la evidencia de un gasto ya APROBADO y comprobable; corre el cuadre por visión y cierra (validada/revision).' })
  addEvidence(@Param('id') id: string, @Body() body: CreateExpenseProofDto, @Req() req: AuthedRequest) {
    return this.svc.addEvidence(id, body, req?.user?.full_name || req?.user?.username);
  }

  // MOMENTO 2 — el aprobador aprueba la solicitud capturada. Mismo permiso que validar.
  @Post(':id/approve')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Aprueba la solicitud capturada (con reclasificación opcional). Comprobable → aprobada (falta evidencia); no comprobable → validada. Auditado.' })
  approve(@Param('id') id: string, @Body() body: { clasificacion?: string; comprobacion_nota?: string }, @Req() req: AuthedRequest) {
    return this.svc.approve(id, req?.user?.full_name || req?.user?.username, body);
  }

  // Validar el gasto lo hace UNA persona (Tesorería). FINANCE_FINDINGS_GESTIONAR lo
  // tienen 27 usuarios porque cubre TODA la bandeja de hallazgos de finanzas; el permiso
  // del dominio es FINANCE_EXPENSES_COMPROBAR, que hoy tiene exactamente una.
  // admin/superadmin siguen pasando por el god-mode del RolesGuard.
  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Valida el expediente de gasto (con reclasificación opcional). Auditado.' })
  validate(@Param('id') id: string, @Body() body: { clasificacion?: string; comprobacion_nota?: string }, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username, body);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: 'Rechaza la solicitud (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
