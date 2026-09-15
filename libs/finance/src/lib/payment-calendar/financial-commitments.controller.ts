import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { FinancialCommitmentsService, CreateFinancialCommitmentDto } from './financial-commitments.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/** Fase TP.1 — Finanzas: compromisos financieros de deuda (ADR-064). Reusa FINANCE_PAYMENTS_*. */
@ApiTags('finance-financial-commitments')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/commitments')
export class FinancialCommitmentsController {
  constructor(private readonly svc: FinancialCommitmentsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  list(
    @Query('status') status?: string, @Query('search') search?: string,
    @Query('dueFrom') dueFrom?: string, @Query('dueTo') dueTo?: string, @Query('subtype') subtype?: string,
  ) {
    return this.svc.list({ status, search, dueFrom, dueTo, subtype });
  }

  @Get(':id')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Captura un compromiso financiero de deuda (factoraje/interés/amortización/otro).' })
  create(@Body() dto: CreateFinancialCommitmentDto, @Req() req: AuthedRequest) {
    return this.svc.create(dto, req.user?.username || 'sistema');
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  cancel(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.cancel(id, body?.reason, req.user?.username || 'sistema');
  }
}
