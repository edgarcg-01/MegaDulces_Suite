import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MaatDiscoveryService } from './maat-discovery.service';
import { MaatSkepticService } from './maat-skeptic.service';

interface AuthedRequest { user?: { username?: string }; }

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
  ) {}

  @Get('discovery')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MIQ.4 — Bandeja de hipótesis de detectores nuevos. status: propuesta|aprobada|rechazada|all.' })
  list(@Query('status') status?: string) { return this.discovery.list(status || 'propuesta'); }

  @Post('discovery/run')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'MIQ.4 — Corre los mineros deterministas + proponedor AI (gated) para generar hipótesis.' })
  run() { return this.discovery.run(); }

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
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'MIQ.4 — Corre el escéptico: refuta hallazgos débiles (materialidad/muestra/estacionalidad) y baja su ranking.' })
  skepticRun() { return this.skeptic.review(); }
}
