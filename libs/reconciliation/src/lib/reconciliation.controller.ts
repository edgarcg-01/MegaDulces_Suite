import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ReconciliationFindingsService } from './reconciliation-findings.service';
import { ReconciliationQueryService } from './reconciliation-query.service';
import { MovementReconcileService } from './movement-reconcile.service';
import { BlindCountService, BlindCountDto } from './blind-count.service';

interface AuthedRequest { user?: { username?: string }; }

@ApiTags('reconciliation')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    private readonly findings: ReconciliationFindingsService,
    private readonly engine: MovementReconcileService,
    private readonly query: ReconciliationQueryService,
    private readonly blind: BlindCountService,
  ) {}

  @Get('overview')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.6 — KPIs + rankings de la consola (caja, inventario, descuadres, top cajeros/sucursales).' })
  overview() { return this.query.overview(); }

  @Get('focos')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.8/P4 — Ranking de focos (caja|cajero) por riesgo compuesto + acción recomendada.' })
  focos(@Query('scope') scope?: string, @Query('limit') limit?: string) {
    return this.query.focos({ scope: scope === 'cajero' ? 'cajero' : 'caja', limit: limit ? Number(limit) : undefined });
  }

  @Get('cash-cuts')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.6 — Cortes de caja (data cruda). Filtros: sucursal, cajero, from, to, min_diff, solo_descuadres, limit.' })
  cashCuts(
    @Query('sucursal') sucursal?: string,
    @Query('cajero') cajero?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('min_diff') minDiff?: string,
    @Query('solo_descuadres') soloDescuadres?: string,
    @Query('limit') limit?: string,
  ) {
    return this.query.cashCuts({ sucursal, cajero, from, to, min_diff: minDiff ? Number(minDiff) : undefined, solo_descuadres: soloDescuadres === 'true', limit: limit ? Number(limit) : undefined });
  }

  @Get('movements')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.6 — Movimientos de inventario (data cruda). Filtros: clase_mov, sucursal, sku, from, to, limit.' })
  movements(
    @Query('clase_mov') claseMov?: string,
    @Query('sucursal') sucursal?: string,
    @Query('sku') sku?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.query.movements({ clase_mov: claseMov, sucursal, sku, from, to, limit: limit ? Number(limit) : undefined });
  }

  @Get('discrepancies')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.1 — Bandeja de descuadres. Filtros: status, plano, severity, rule_key, limit. Default: pendientes.' })
  list(
    @Query('status') status?: string,
    @Query('plano') plano?: string,
    @Query('severity') severity?: string,
    @Query('rule_key') ruleKey?: string,
    @Query('limit') limit?: string,
  ) {
    return this.findings.list({ status, plano, severity, rule_key: ruleKey, limit: limit ? Number(limit) : undefined });
  }

  @Get('discrepancies/stats')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.1 — KPIs: pendientes, críticos, $ en juego, por plano.' })
  stats() { return this.findings.stats(); }

  @Get('rules')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.1 — Salud de reglas: precisión, conteos, enabled/pinned/suprimida.' })
  rules() { return this.findings.rules(); }

  @Patch('discrepancies/:id/status')
  @RequirePermissions(Permission.RECONCILIATION_GESTIONAR)
  @ApiOperation({ summary: 'SM.1 — Cambia estado de triage (nuevo|en_revision|confirmado|descartado|corregido).' })
  setStatus(@Param('id') id: string, @Body('status') status: string, @Req() req: AuthedRequest) {
    return this.findings.setStatus(id, status, req?.user?.username);
  }

  @Post('discrepancies/:id/feedback')
  @RequirePermissions(Permission.RECONCILIATION_GESTIONAR)
  @ApiOperation({ summary: 'SM.1 — Veredicto (util|falso|duplicado|ya_corregido) + causa confirmada. Recalcula precisión (L2).' })
  feedback(@Param('id') id: string, @Body() body: { verdict: string; causa?: string; nota?: string }, @Req() req: AuthedRequest) {
    return this.findings.feedback(id, body?.verdict, body?.causa, body?.nota, req?.user?.username);
  }

  @Post('rules/:rule_key/pin')
  @RequirePermissions(Permission.RECONCILIATION_GESTIONAR)
  @ApiOperation({ summary: 'SM.1 — Fija/desfija una regla (pinned = nunca auto-suprimir).' })
  pin(@Param('rule_key') ruleKey: string, @Body('pinned') pinned: boolean) {
    return this.findings.pinRule(ruleKey, !!pinned);
  }

  @Post('scan')
  @RequirePermissions(Permission.RECONCILIATION_GESTIONAR)
  @Throttle({ long: { limit: 4, ttl: 60_000 } })
  @ApiOperation({ summary: 'SM.1 — Corre el motor de cuadre ahora (manual). Idempotente (UPSERT por dedup_key).' })
  scan() { return this.engine.scanAll('manual'); }

  @Post('blind-counts')
  @RequirePermissions(Permission.RECONCILIATION_GESTIONAR)
  @ApiOperation({ summary: 'SM.8/P1 — Captura de arqueo CIEGO (denominaciones). Devuelve la diferencia real vs el esperado de Kepler.' })
  submitBlindCount(@Body() body: BlindCountDto, @Req() req: AuthedRequest) {
    return this.blind.submit(body, req?.user?.username);
  }

  @Get('blind-counts')
  @RequirePermissions(Permission.RECONCILIATION_VER)
  @ApiOperation({ summary: 'SM.8/P1 — Arqueos ciegos capturados con su comparación vs Kepler. Filtros: from, to, warehouse_code, limit.' })
  listBlindCounts(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('warehouse_code') warehouseCode?: string,
    @Query('limit') limit?: string,
  ) {
    return this.blind.list({ from, to, warehouse_code: warehouseCode, limit: limit ? Number(limit) : undefined });
  }
}
