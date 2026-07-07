import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { MaatFindingsService } from './maat-findings.service';
import { MaatDetectorService } from './maat-detector.service';
import { MaatProviderGraphService } from './maat-provider-graph.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat/findings')
export class MaatFindingsController {
  constructor(
    private readonly findings: MaatFindingsService,
    private readonly detector: MaatDetectorService,
    private readonly graph: MaatProviderGraphService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.2 — Bandeja de hallazgos. Filtros: status, clase, severity, rule_key, limit. Default: pendientes (nuevo/en_revision).' })
  list(
    @Query('status') status?: string,
    @Query('clase') clase?: string,
    @Query('severity') severity?: string,
    @Query('rule_key') ruleKey?: string,
    @Query('limit') limit?: string,
  ) {
    return this.findings.list({ status, clase, severity, rule_key: ruleKey, limit: limit ? Number(limit) : undefined });
  }

  @Get('stats')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.2 — KPIs de la bandeja: pendientes, críticos, $ en riesgo, por clase.' })
  stats() { return this.findings.stats(); }

  @Get('rules')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.2 — Salud de las reglas: precisión, conteos, enabled/pinned/suprimida.' })
  rules() { return this.findings.rules(); }

  @Patch(':id/status')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.2 — Cambia el estado de triage (nuevo|en_revision|confirmado|descartado|corregido).' })
  setStatus(@Param('id') id: string, @Body('status') status: string, @Req() req: AuthedRequest) {
    return this.findings.setStatus(id, status, req?.user?.username);
  }

  @Post(':id/feedback')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.2 — Veredicto (util|falso|duplicado|ya_corregido). Recalcula precisión de la regla + auto-supresión (L2).' })
  feedback(@Param('id') id: string, @Body() body: { verdict: string; nota?: string }, @Req() req: AuthedRequest) {
    return this.findings.feedback(id, body?.verdict, body?.nota, req?.user?.username);
  }

  @Post('rules/:rule_key/pin')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.2 — Fija/desfija una regla (pinned = nunca auto-suprimir; reactiva si estaba suprimida).' })
  pin(@Param('rule_key') ruleKey: string, @Body('pinned') pinned: boolean) {
    return this.findings.pinRule(ruleKey, !!pinned);
  }

  @Post('scan')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 4, ttl: 60_000 } })
  @ApiOperation({ summary: 'MAAT.2 — Corre el motor de detectores ahora (manual). Idempotente (UPSERT por dedup_key).' })
  scan() { return this.detector.scanAll('manual'); }

  @Post('graph-sync')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 2, ttl: 60_000 } })
  @ApiOperation({ summary: 'MAAT.10 — Reconstruye el grafo de proveedores en Neo4j desde analytics.expense_documents. No-op si NEO4J_URI no está.' })
  graphSync() { return this.graph.sync(this.tenantCtx.requireTenantId()); }
}
