import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RolesGuard } from '@megadulces/platform-core';
import type { HrCumplimientoDto } from '@megadulces/contracts';
import { HrAttendanceCumplimientoService } from './attendance-cumplimiento.service';

/**
 * Fase RH · `[RH.15.0]` `[RH.15.7]` `[RH.15.8]` — Cumplimiento de una plaza. Lo ve quien ve la asistencia. Sin permiso
 * nuevo. Controlador propio (ver `attendance-signoffs`).
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance/compliance')
export class HrAttendanceCumplimientoController {
  constructor(private readonly cumplimiento: HrAttendanceCumplimientoService) {}

  @Get()
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — huellas de bajas en el reloj, hasta cuándo se conservan y quién no registra.' })
  estado(@Query('site_code') site: string, @Query('hoy') hoy?: string): Promise<HrCumplimientoDto> {
    return this.cumplimiento.estado({ site_code: site, hoy });
  }
}
