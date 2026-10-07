import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission, SkipTenantTx } from '@megadulces/platform-core';
import { MaatDiscoveryService } from './maat-discovery.service';
import { MaatSkepticService } from './maat-skeptic.service';
import { FinanceJobsService } from '../jobs/finance-jobs.service';

interface AuthedRequest { user?: { username?: string }; }

/** `?sync=true` (o `sync: true` en el body) fuerza el camino inline: CLI y smokes. */
function wantsInline(q?: string, b?: boolean): boolean {
  return b === true || q === 'true' || q === '1';
}

/**
 * MAAT-IQ · MIQ.4 — Descubrimiento de detectores + escéptico. La bandeja de
 * hipótesis (HITL, ADR-013) y la verificación adversarial. Lectura FINANCE_AI_CHAT;
 * correr/decidir FINANCE_FINDINGS_GESTIONAR.
 */
@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat')
export class MaatDiscoveryController {
  constructor(
    private readonly discovery: MaatDiscoveryService,
    private readonly skeptic: MaatSkepticService,
    private readonly jobs: FinanceJobsService,
  ) {}

  @Get('discovery')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MIQ.4 — Bandeja de hipótesis de detectores nuevos. status: propuesta|aprobada|rechazada|all.' })
  list(@Query('status') status?: string) { return this.discovery.list(status || 'propuesta'); }

  @Post('discovery/run')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @SkipTenantTx()
  @Throttle({ long: { limit: 3, ttl: 60_000 } })
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'MIQ.4 — Corre los mineros deterministas + proponedor AI (gated) para generar hipótesis. Async: 202 + job_id, resultado por WS `finance_job` (llama al LLM: no cabe en los 60 s de nginx).' })
  run(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (wantsInline(sync, body?.sync)) return this.discovery.run();
    res.status(202);
    return this.jobs.run({
      name: 'maat-discovery',
      label: 'Búsqueda de hipótesis',
      actor: req?.user?.username || null,
      exec: () => this.discovery.run(),
    });
  }

  @Post('discovery/:id/approve')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MIQ.4 — Aprueba una hipótesis (backlog de detector a codificar/activar).' })
  approve(@Param('id') id: string, @Req() req: AuthedRequest) { return this.discovery.decide(id, true, req?.user?.username); }

  @Post('discovery/:id/reject')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MIQ.4 — Rechaza una hipótesis.' })
  reject(@Param('id') id: string, @Body('nota') _nota: string, @Req() req: AuthedRequest) { return this.discovery.decide(id, false, req?.user?.username); }

  @Post('skeptic/run')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @SkipTenantTx()
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'MIQ.4 — Corre el escéptico: refuta hallazgos débiles (materialidad/muestra/estacionalidad) y baja su ranking. Async: 202 + job_id.' })
  skepticRun(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (wantsInline(sync, body?.sync)) return this.skeptic.review();
    res.status(202);
    return this.jobs.run({
      name: 'maat-skeptic',
      label: 'Escéptico',
      actor: req?.user?.username || null,
      exec: () => this.skeptic.review(),
    });
  }
}
