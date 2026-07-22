import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { FinanceBankService, ListMovementsQuery } from './finance-bank.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * CB.2 — Conciliación bancaria (ADR-033). Lectura del tablero (cuentas, catálogo,
 * estados de cuenta, movimientos, CONCENTRADO) + reclasificación de movimientos.
 * Lectura = FINANCE_BANK_VER · gestión (subir/reclasificar/reglas/match) = FINANCE_BANK_GESTIONAR.
 */
@ApiTags('finance-bank')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/bank')
export class FinanceBankController {
  constructor(private readonly svc: FinanceBankService) {}

  @Get('accounts')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Cuentas de banco/caja/factoraje.' })
  accounts() { return this.svc.accounts(); }

  @Get('categories')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Catálogo de categorías limpias (alineado a Kepler).' })
  categories() { return this.svc.categories(); }

  @Get('periods')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Periodos con estados de cuenta cargados.' })
  periods() { return this.svc.periods(); }

  @Get('statements')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Estados de cuenta de un periodo (por cuenta) con totales.' })
  statements(@Query('period') period?: string) { return this.svc.statements(period); }

  @Get('concentrado')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Tablero CONCENTRADO: pivote cuenta × grupo + totales.' })
  concentrado(@Query('period') period?: string) { return this.svc.concentrado(period); }

  @Get('reconciliation')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Conciliación banco↔Kepler: caja (102) + P&L por cuenta, con deltas.' })
  reconciliation(@Query('period') period?: string) { return this.svc.reconciliation(period); }

  @Post('match')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Corre el matching por-transacción (retiros banco ↔ pagos Kepler 102).' })
  match(@Body() body: { period?: string }) { return this.svc.runMatch(body?.period); }

  @Get('differences')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Diferencias de conciliación: retiros banco y pagos Kepler sin casar (por monto).' })
  differences(@Query('period') period?: string) { return this.svc.differences(period); }

  @Get('balances')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Cuadre de saldos por cuenta (inicial + depósitos − retiros == final) + check TI=TE.' })
  balances(@Query('period') period?: string) { return this.svc.balances(period); }

  @Get('diagnostico')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: '¿Por qué no cuadra? Lista accionable de descuadres (sin clasificar, saldos, faltantes, Kepler).' })
  diagnostico(@Query('period') period?: string) { return this.svc.diagnostico(period); }

  @Post('findings/sync')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Empuja las diferencias de conciliación a la bandeja de hallazgos de Maat.' })
  syncFindings(@Body() body: { period?: string }) { return this.svc.syncFindings(body?.period); }

  @Get('movements')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Movimientos filtrados (grid), paginados.' })
  movements(
    @Query('period') period?: string,
    @Query('account_id') account_id?: string,
    @Query('category_id') category_id?: string,
    @Query('group_key') group_key?: string,
    @Query('uncategorized') uncategorized?: string,
    @Query('recon_status') recon_status?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const q: ListMovementsQuery = {
      period, account_id, category_id, group_key, uncategorized, recon_status, search,
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
    };
    return this.svc.movements(q);
  }

  @Post('import')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Sube un workbook Excel (base64) y lo importa/concilia por periodo.' })
  import(@Body() body: { file_base64?: string; period?: string; source_file?: string }, @Req() req: AuthedRequest) {
    return this.svc.importWorkbook(body?.file_base64 || '', body?.period || '', body?.source_file, req?.user?.full_name || req?.user?.username);
  }

  @Patch('movements/:id/category')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Reclasifica un movimiento (asigna/limpia categoría).' })
  reclassify(@Param('id') id: string, @Body() body: { category_id?: string | null }, @Req() req: AuthedRequest) {
    return this.svc.reclassify(id, body?.category_id ?? null, req?.user?.full_name || req?.user?.username);
  }

  // ── CB.6 — Admin: catálogo + reglas de clasificación ──

  @Post('accounts')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Alta/edición de cuenta de banco (upsert por bank+label).' })
  createAccount(@Body() body: any, @Req() req: AuthedRequest) { return this.svc.createAccount(body, req?.user?.full_name || req?.user?.username); }

  @Patch('accounts/:id')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Edita una cuenta (alias/kepler_link/kind/active).' })
  updateAccount(@Param('id') id: string, @Body() body: any) { return this.svc.updateAccount(id, body); }

  @Post('categories')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Alta/edición de categoría del catálogo (upsert por code).' })
  createCategory(@Body() body: any, @Req() req: AuthedRequest) { return this.svc.createCategory(body, req?.user?.full_name || req?.user?.username); }

  @Patch('categories/:id')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Edita una categoría (name/kepler_account/group_key/flow/active).' })
  updateCategory(@Param('id') id: string, @Body() body: any) { return this.svc.updateCategory(id, body); }

  @Get('rules')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Reglas de clasificación (por prioridad).' })
  rules() { return this.svc.rules(); }

  @Post('rules')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Alta de regla de clasificación.' })
  createRule(@Body() body: any, @Req() req: AuthedRequest) { return this.svc.createRule(body, req?.user?.full_name || req?.user?.username); }

  @Patch('rules/:id')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Edita una regla de clasificación.' })
  updateRule(@Param('id') id: string, @Body() body: any) { return this.svc.updateRule(id, body); }

  @Delete('rules/:id')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Elimina una regla de clasificación.' })
  deleteRule(@Param('id') id: string) { return this.svc.deleteRule(id); }

  @Post('reclassify')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Re-aplica las reglas a movimientos ya importados (respeta manual).' })
  reclassifyAll(@Body() body: { period?: string }) { return this.svc.reclassifyAll(body?.period); }
}
