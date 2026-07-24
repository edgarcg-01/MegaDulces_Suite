import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MaatReconTasksService } from './maat-recon-tasks.service';

interface AuthedRequest { user?: { sub?: string; username?: string; full_name?: string }; }

/**
 * MA.3 — Endpoints de tareas de conciliación (Maat · ADR-028/016).
 *
 *   Ver la propia bandeja / pool  → FINANCE_BANK_VER
 *   Resolver / cambiar estado     → FINANCE_BANK_GESTIONAR (el asignado)
 *   Correr el motor / repartir / reasignar → FINANCE_RECON_ASIGNAR (líder)
 */
@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat/recon-tasks')
export class MaatReconTasksController {
  constructor(private readonly tasks: MaatReconTasksService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'MA — Bandeja de tareas. scope=me|all|pool, status, periodo, limit. Default: abiertas.' })
  list(
    @Query('scope') scope: 'me' | 'all' | 'pool' | undefined,
    @Query('status') status: string | undefined,
    @Query('periodo') periodo: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.tasks.list({ scope: scope || 'all', userId: req?.user?.sub, status, periodo, limit: limit ? Number(limit) : undefined });
  }

  @Get('stats')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'MA — KPIs: pendientes/en_proceso/resueltas/pool, $ abierto, carga por usuario.' })
  stats(@Query('periodo') periodo?: string) { return this.tasks.stats(periodo); }

  @Get('finance-users')
  @RequirePermissions(Permission.FINANCE_RECON_ASIGNAR)
  @ApiOperation({ summary: 'MA — Usuarios de Finanzas candidatos (para el selector de asignación manual).' })
  financeUsers() { return this.tasks.financeUsers(); }

  @Post('run')
  @RequirePermissions(Permission.FINANCE_RECON_ASIGNAR)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'MA — Motor: construye tareas del periodo (agrupa por proveedor), verifica cierres y reparte. min_importe opcional (grandes primero).' })
  run(@Body() body: { periodo: string; min_importe?: number }) {
    return this.tasks.run(body?.periodo, body?.min_importe != null ? Number(body.min_importe) : undefined);
  }

  @Post('assign-pending')
  @RequirePermissions(Permission.FINANCE_RECON_ASIGNAR)
  @ApiOperation({ summary: 'MA — Reparto automático de las tareas pendientes sin dueño (round-robin balanceado).' })
  assignPending(@Body() body: { periodo?: string }) { return this.tasks.assignPending(body?.periodo); }

  @Post('verify-closure')
  @RequirePermissions(Permission.FINANCE_RECON_ASIGNAR)
  @ApiOperation({ summary: 'MA — Cierra por re-match las tareas cuyos movimientos ya se conciliaron en Kepler.' })
  verifyClosure(@Body() body: { periodo?: string }) { return this.tasks.verifyClosure(body?.periodo); }

  @Patch(':id/status')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'MA — Cambia el estado (en_proceso|resuelto|no_aplica) + nota + folio Kepler opcional.' })
  setStatus(@Param('id') id: string, @Body() body: { status: string; note?: string; kepler_ref?: string }, @Req() req: AuthedRequest) {
    return this.tasks.setStatus(id, body?.status, { note: body?.note, kepler_ref: body?.kepler_ref, actor: req?.user?.username });
  }

  @Post(':id/assign')
  @RequirePermissions(Permission.FINANCE_RECON_ASIGNAR)
  @ApiOperation({ summary: 'MA — Asigna/reasigna manualmente a un usuario (user_id null = devolver al pool).' })
  assignManual(@Param('id') id: string, @Body() body: { user_id: string | null }, @Req() req: AuthedRequest) {
    return this.tasks.assignManual(id, body?.user_id ?? null, req?.user?.username);
  }
}
