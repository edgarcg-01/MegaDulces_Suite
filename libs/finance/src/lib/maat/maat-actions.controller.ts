import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { MaatActionsService } from './maat-actions.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat/actions')
export class MaatActionsController {
  constructor(private readonly actions: MaatActionsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.9 — Acciones propuestas por Maat (HITL). Default: pendientes de aprobación.' })
  list(@Query('estado') estado?: string, @Query('limit') limit?: string) {
    return this.actions.list({ estado, limit: limit ? Number(limit) : undefined });
  }

  @Get('stats')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.9 — Conteo de acciones por estado.' })
  stats() { return this.actions.stats(); }

  @Post(':id/approve')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.9 — Aprueba y EJECUTA la acción (efecto en nuestras tablas; nunca Kepler). Auditado.' })
  approve(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.actions.approve(id, req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.9 — Rechaza la acción (no se ejecuta).' })
  reject(@Param('id') id: string, @Body() body: { nota?: string }, @Req() req: AuthedRequest) {
    return this.actions.reject(id, req?.user?.username, body?.nota);
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.9 — Alta manual de una acción propuesta (además de las que crea Maat en el chat).' })
  propose(@Body() body: { kind: string; titulo: string; descripcion?: string; efecto?: string; importe?: number }, @Req() req: AuthedRequest) {
    return this.actions.propose({ ...body, origen: 'manual', created_by: req?.user?.username });
  }
}
