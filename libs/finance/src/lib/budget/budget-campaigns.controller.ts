import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BudgetCampaignsService, CreateCampaignDto, ContributionDto } from './budget-campaigns.service';

interface AuthedRequest { user?: { username?: string } }

/**
 * Fase PU.5 — Presupuestos: Marketing (campañas) (ADR-066, spec §9). Catálogo de campañas + etiqueta
 * de partidas + aportaciones de proveedor + evaluación honesta. Reusa `PRESUPUESTOS_VER/GESTIONAR`
 * (captura controlada dentro de Presupuestos, spec §6).
 */
@ApiTags('finance-budget-campaigns')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/budget/campaigns')
export class BudgetCampaignsController {
  constructor(private readonly svc: BudgetCampaignsService) {}
  private who(req: AuthedRequest) { return req.user?.username || 'sistema'; }

  @Get()
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  list() { return this.svc.list(); }

  @Post()
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  create(@Body() dto: CreateCampaignDto, @Req() req: AuthedRequest) { return this.svc.create(dto, this.who(req)); }

  @Get(':id')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  get(@Param('id') id: string) { return this.svc.get(id); }

  @Post(':id/status')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  setStatus(@Param('id') id: string, @Body() body: { status: 'borrador' | 'activa' | 'cerrada' }, @Req() req: AuthedRequest) {
    return this.svc.setStatus(id, body?.status, this.who(req));
  }

  @Get(':id/evaluate')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  @ApiOperation({ summary: 'Costo vs resultado. Ventas por VENTANA (atribución declarada, no incremental); retorno solo con margen_incremental explícito.' })
  evaluate(@Param('id') id: string, @Query('margen_incremental') margen?: string) {
    return this.svc.evaluate(id, { margen_incremental: margen != null ? Number(margen) : undefined });
  }

  // ── Etiqueta partida → campaña ──
  @Post(':id/lines')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  @ApiOperation({ summary: 'Etiqueta una partida con esta campaña.' })
  linkLine(@Param('id') id: string, @Body() body: { lineId: string }, @Req() req: AuthedRequest) {
    return this.svc.linkLine(body?.lineId, id, this.who(req));
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  unlinkLine(@Param('lineId') lineId: string, @Req() req: AuthedRequest) {
    return this.svc.linkLine(lineId, null, this.who(req));
  }

  // ── Aportaciones de proveedor ──
  @Get(':id/contributions')
  @RequirePermissions(Permission.PRESUPUESTOS_VER)
  listContributions(@Param('id') id: string) { return this.svc.listContributions(id); }

  @Post(':id/contributions')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  addContribution(@Param('id') id: string, @Body() dto: ContributionDto, @Req() req: AuthedRequest) {
    return this.svc.addContribution(id, dto, this.who(req));
  }

  @Post(':id/contributions/:cid/status')
  @RequirePermissions(Permission.PRESUPUESTOS_GESTIONAR)
  setContributionStatus(@Param('cid') cid: string, @Body() body: { status: 'incierta' | 'confirmada' | 'aplicada' }, @Req() req: AuthedRequest) {
    return this.svc.setContributionStatus(cid, body?.status, this.who(req));
  }
}
