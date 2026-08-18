import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, SkipTenantTx } from '@megadulces/platform-core';
import { FinanceBankService, ListMovementsQuery } from './finance-bank.service';
import { SheetSyncService } from './sheet-sync.service';
import { FinanceJobsService } from '../jobs/finance-jobs.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/** `?sync=true` (o `sync: true` en el body) fuerza el camino inline: CLI y smokes. */
function wantsInline(q?: string, b?: boolean): boolean {
  return b === true || q === 'true' || q === '1';
}

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
  constructor(
    private readonly svc: FinanceBankService,
    private readonly sheetSync: SheetSyncService,
    private readonly jobs: FinanceJobsService,
  ) {}

  /**
   * COMM-P0 — Delega un motor largo a background y responde 202 + `job_id`; el
   * resultado sale por WS (`finance_job`). Sin esto, los 60 s de `location /api/`
   * en nginx devolvían 504 con el trabajo a medias. Ver FinanceJobsService.
   *
   * Los endpoints que delegan llevan `@SkipTenantTx()`: el interceptor abre una
   * transacción legacy alrededor de TODO el handler y la commitea al devolver el
   * 202, así que un exec que la usara por CLS escribiría en una trx ya cerrada.
   * Además liberamos esa conexión en vez de tenerla ocupada durante el trabajo.
   * (Los services de Finanzas usan `TenantKnexService`, que abre su propia trx.)
   */
  private delegate<T>(res: Response, name: string, label: string, actor: string | undefined, exec: () => Promise<T>) {
    res.status(202);
    return this.jobs.run({ name, label, actor: actor ?? null, exec });
  }

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
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'Corre el matching por-transacción (retiros banco ↔ pagos Kepler 102). Async: 202 + job_id, resultado por WS `finance_job`.' })
  match(
    @Body() body: { period?: string; sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const period = body?.period;
    if (wantsInline(sync, body?.sync)) return this.svc.runMatch(period);
    const label = 'Conciliación ' + (period || 'periodo actual');
    return this.delegate(res, 'bank-match', label, req?.user?.full_name || req?.user?.username, () => this.svc.runMatch(period));
  }

  @Get('differences')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Diferencias de conciliación: retiros banco y pagos Kepler sin casar (por monto).' })
  differences(@Query('period') period?: string) { return this.svc.differences(period); }

  @Get('ingresos-control')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Control de ingresos: cada depósito vs tesorería/cobranza/caja; excepciones sin explicar + fuga.' })
  ingresosControl(@Query('period') period?: string) { return this.svc.ingresosControl(period); }

  @Get('balances')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Cuadre de saldos por cuenta (inicial + depósitos − retiros == final) + check TI=TE.' })
  balances(@Query('period') period?: string) { return this.svc.balances(period); }

  @Get('diagnostico')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: '¿Por qué no cuadra? Lista accionable de descuadres (sin clasificar, saldos, faltantes, Kepler).' })
  diagnostico(@Query('period') period?: string) { return this.svc.diagnostico(period); }

  @Get('parse-check')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Verifica el parseo cuenta×tipo contra la hoja CONCENTRADO (Δ≠0 = error de captura nuestro).' })
  parseCheck(@Query('period') period?: string) { return this.svc.parseCheck(period); }

  @Get('kepler-accounts')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Búsqueda en el catálogo real de cuentas de Kepler (clave o descripción).' })
  keplerAccounts(@Query('search') search?: string) { return this.svc.keplerAccounts(search); }

  @Post('findings/sync')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'Empuja las diferencias de conciliación a la bandeja de hallazgos de Maat. Async: 202 + job_id.' })
  syncFindings(
    @Body() body: { period?: string; sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const period = body?.period;
    if (wantsInline(sync, body?.sync)) return this.svc.syncFindings(period);
    const label = 'Hallazgos ' + (period || 'periodo actual');
    return this.delegate(res, 'bank-findings-sync', label, req?.user?.full_name || req?.user?.username, () => this.svc.syncFindings(period));
  }

  // ── CP.2 (Fase CP, ADR-040) — Comparación con la contabilidad ContPAQi ──

  @Post('contpaqi/link')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Auto-enlaza las cuentas de banco con su cuenta contable ContPAQi (102xxx) por familia + número.' })
  contpaqiLink() { return this.svc.linkContpaqi(); }

  @Get('contpaqi-accounts')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Catálogo de cuentas contables de banco ContPAQi (102xxx) para el selector de enlace manual.' })
  contpaqiAccounts() { return this.svc.contpaqiBankAccounts(); }

  @Post('contpaqi/manual-link')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Enlace manual cuenta de banco ↔ cuenta contable ContPAQi (cuando el auto-match no casa por distinto número).' })
  contpaqiManualLink(@Body() body: { bank_account_id: string; contpaqi_cuenta: string | null }) {
    return this.svc.manualLinkContpaqi(body?.bank_account_id, body?.contpaqi_cuenta ?? null);
  }

  @Get('contpaqi-compare')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Excel/estado de cuenta vs LIBROS ContPAQi por cuenta y periodo (la 3ª columna de verdad + deltas).' })
  contpaqiCompare(@Query('period') period?: string) { return this.svc.contpaqiCompare(period); }

  @Get('contpaqi-detail')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: '¿DÓNDE está el descuadre? Movimiento a movimiento banco vs póliza ContPAQi de una cuenta: huérfanos de cada lado.' })
  contpaqiDetail(@Query('period') period?: string, @Query('account_id') accountId?: string) {
    return this.svc.contpaqiAccountDetail(period, accountId);
  }

  @Get('factoraje-compare')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Factoraje a proveedores: compras factoradas del Excel POR PROVEEDOR vs su CxP (212x) y costo (50x) en ContPAQi.' })
  factorajeCompare(@Query('period') period?: string) { return this.svc.factorajeCompare(period); }

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

  @Get('movements/:id/flow')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Flujo de un movimiento: cadena compra→pago (proveedor) o cómo Kepler tiene la cobranza (depósito).' })
  movementFlow(@Param('id') id: string) { return this.svc.movementFlow(id); }

  @Post('import')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = importa inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'Sube un workbook Excel (base64) y lo importa/concilia por periodo. Async: 202 + job_id, resultado por WS `finance_job` (un workbook de ~6.5k movimientos se pasaba de los 60 s de nginx).' })
  import(
    @Body() body: { file_base64?: string; period?: string; source_file?: string; sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = body?.file_base64 || '';
    const period = body?.period || '';
    const source = body?.source_file;
    const actor = req?.user?.full_name || req?.user?.username;
    if (wantsInline(sync, body?.sync)) return this.svc.importWorkbook(file, period, source, actor);
    const label = 'Import ' + (period || 'sin periodo');
    return this.delegate(res, 'bank-import', label, actor, () => this.svc.importWorkbook(file, period, source, actor));
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
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'Re-aplica las reglas a movimientos ya importados (respeta manual). Async: 202 + job_id.' })
  reclassifyAll(
    @Body() body: { period?: string; sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const period = body?.period;
    if (wantsInline(sync, body?.sync)) return this.svc.reclassifyAll(period);
    const label = 'Reclasificar ' + (period || 'todo');
    return this.delegate(res, 'bank-reclassify', label, req?.user?.full_name || req?.user?.username, () => this.svc.reclassifyAll(period));
  }

  // ── CB.24 — Cuadre 3 vías (Workbook ↔ Kepler 102 ↔ ContPAQi) ──

  @Get('three-way')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Cuadre 3 vías: control-total Workbook/Kepler/ContPAQi + por cuenta + cobertura.' })
  threeWay(@Query('period') period?: string) { return this.svc.threeWay(period); }

  @Get('three-way-detail')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'CB.33 — Drill 3 vías por cuenta a nivel movimiento (Excel ↔ Kepler ↔ ContPAQi) + huérfanos.' })
  threeWayDetail(@Query('period') period?: string, @Query('account_label') accountLabel?: string) { return this.svc.threeWayDetail(period, accountLabel); }

  @Get('cheques-transito')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'CB.30 — Cheques Kepler del periodo: cobrados vs en tránsito (gap de timing banco↔Kepler).' })
  chequesTransito(@Query('period') period?: string) { return this.svc.chequesEnTransito(period); }

  // ── CB.23 — Sync del workbook maestro (Google Sheet vía export público) ──

  @Get('sheet-sync/config')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Config + estado del sync del workbook maestro (Sheet id, periodo, activo, última corrida).' })
  sheetSyncConfig() { return this.sheetSync.config(); }

  @Patch('sheet-sync/config')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Edita la config del sync (sheet_id / period / active).' })
  sheetSyncUpdate(@Body() body: { sheet_id?: string; period?: string; active?: boolean }) { return this.sheetSync.updateConfig(body); }

  @Post('sheet-sync/run')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'Sincroniza AHORA el workbook maestro (baja el .xlsx del Sheet y lo procesa; force ignora el hash). Async: 202 + job_id.' })
  sheetSyncRun(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (wantsInline(sync, body?.sync)) return this.sheetSync.syncCurrent({ force: true });
    return this.delegate(res, 'bank-sheet-sync', 'Sync del workbook maestro', req?.user?.full_name || req?.user?.username, () => this.sheetSync.syncCurrent({ force: true }));
  }
}
