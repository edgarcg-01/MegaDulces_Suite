import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { BankCaptureService } from './bank-capture.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * Fase CBW (ADR-042) — Bandeja de capturas bancarias por WhatsApp.
 * Lectura (VER) = ver la bandeja; gestión (GESTIONAR) = validar/rechazar/cuadrar +
 * administrar remitentes. Reusa los permisos de Bancos (CB). No escribe a
 * bank_movements salvo la liga de cuadre (bank_movement_id).
 */
@ApiTags('finance-bank-captures')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/bank-captures')
export class BankCaptureController {
  constructor(private readonly svc: BankCaptureService) {}

  private actor(req: AuthedRequest): string {
    return req.user?.full_name || req.user?.username || 'sistema';
  }

  @Get()
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Lista las capturas de WhatsApp + KPIs por estado.' })
  list(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list({ status, from, to, search, limit: limit ? Number(limit) : undefined });
  }

  // Admin de remitentes ANTES de :id para no colisionar.
  @Get('senders')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Lista los remitentes autorizados (allowlist).' })
  senders() {
    return this.svc.listSenders();
  }

  @Post('senders')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  createSender(@Body() body: { phone: string; full_name: string; sucursal?: string; default_bank_account_id?: string }, @Req() req: AuthedRequest) {
    return this.svc.createSender({ ...body, created_by: this.actor(req) });
  }

  @Patch('senders/:id')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  updateSender(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.svc.updateSender(id, body);
  }

  @Get(':id')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  detail(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Get(':id/match-candidates')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Movimientos del estado de cuenta candidatos a cuadrar (monto±$1, fecha±7d).' })
  candidates(@Param('id') id: string) {
    return this.svc.matchCandidates(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Corrige la atribución (cuenta/sucursal/concepto/monto/fecha).' })
  update(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.svc.updateAttribution(id, body);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, this.actor(req));
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, this.actor(req), body?.motivo);
  }

  @Post(':id/match')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Cuadra la captura contra un movimiento del estado de cuenta + valida.' })
  match(@Param('id') id: string, @Body() body: { bank_movement_id: string }, @Req() req: AuthedRequest) {
    return this.svc.matchMovement(id, body.bank_movement_id, this.actor(req));
  }
}
