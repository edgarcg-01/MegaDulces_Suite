import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RolesGuard } from '@megadulces/platform-core';
import { FinanceJobsService } from './finance-jobs.service';

/**
 * COMM-P0 — Consulta de los trabajos largos de Finanzas (import, conciliación,
 * reclasificado, motores de Maat). El camino normal para saber que terminaron es
 * el evento WS `finance_job`; esto es el respaldo para cuando la pantalla se
 * recargó a media corrida o para diagnosticar desde Swagger.
 *
 * Registro EN MEMORIA del proceso (últimos 50): un reinicio lo borra y otra
 * instancia no lo ve. Persistirlo es el paso siguiente, junto con mover el
 * trabajo a `pg-boss` cuando el worker-tier esté desplegado.
 *
 * Gate OR: lo abren tanto quien ve Bancos (FINANCE_BANK_VER) como quien ve la
 * bandeja de hallazgos (FINANCE_AI_CHAT, el mismo gate de lectura que usa esa
 * pantalla) — sin inventar un permiso nuevo, que obligaría a seed + re-login.
 */
@ApiTags('finance-jobs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/jobs')
export class FinanceJobsController {
  constructor(private readonly jobs: FinanceJobsService) {}

  @Get()
  @RequireAnyPermission(Permission.FINANCE_BANK_VER, Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'Trabajos largos recientes del tenant (memoria del proceso, más reciente primero).' })
  recent(@Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
    return this.jobs.recent(n);
  }

  @Get(':id')
  @RequireAnyPermission(Permission.FINANCE_BANK_VER, Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'Estado de un trabajo (`running` | `done` | `error`) con su resultado.' })
  get(@Param('id') id: string) {
    const rec = this.jobs.get(id);
    if (!rec) throw new NotFoundException('job no encontrado (pudo rotar del registro en memoria)');
    return rec;
  }
}
