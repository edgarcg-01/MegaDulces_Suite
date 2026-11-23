import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { HrFirmaSemanaDto, HrFirmasSemanaDto, HrRegistrarFirmaBody } from '@megadulces/contracts';
import { HrAttendanceSignoffsService } from './attendance-signoffs.service';

/** Quien ve los cierres ve las firmas (mismo conjunto que `VER_INCIDENCIAS` del controlador de asistencia). */
const VER_FIRMAS = [
  Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR,
  Permission.HR_INCIDENTS_AUDITAR, Permission.HR_PERIOD_CLOSE,
];

/**
 * Fase RH · `[RH.15.5]` — La firma de la semana (LFT 132-XXXIV). Controlador propio, no un parámetro más en el de
 * asistencia: cambiar la firma inyectada de un controlador que ya corre en prod es lo que tumbó la API en el #414.
 * Registrar y anular, con la llave de cerrar la semana; ver, con la de ver los cierres. Sin permiso nuevo.
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance/signoffs')
export class HrAttendanceSignoffsController {
  constructor(private readonly firmas: HrAttendanceSignoffsService) {}

  @Get()
  @RequireAnyPermission(...VER_FIRMAS)
  @ApiOperation({ summary: 'RH — cómo va la firma de una semana cerrada: por departamento, quién firmó, y las hojas.' })
  estado(@Query('site_code') site: string, @Query('period_start') desde: string): Promise<HrFirmasSemanaDto> {
    return this.firmas.estado({ site_code: site, period_start: desde });
  }

  @Post()
  @RequirePermissions(Permission.HR_PERIOD_CLOSE)
  @ApiOperation({ summary: 'RH — registra la hoja de un departamento firmada por las personas y su jefe de área (PDF o foto).' })
  registrar(@Body() b: HrRegistrarFirmaBody): Promise<HrFirmaSemanaDto> {
    return this.firmas.registrar(b);
  }

  @Get(':id/file')
  @RequireAnyPermission(...VER_FIRMAS)
  @ApiOperation({ summary: 'RH — liga temporal para ver la hoja firmada.' })
  archivo(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ url: string }> {
    return this.firmas.archivo(id);
  }

  @Post(':id/void')
  @RequirePermissions(Permission.HR_PERIOD_CLOSE)
  @ApiOperation({ summary: 'RH — anula una hoja registrada por error (no se borra; queda el motivo).' })
  anular(@Param('id', new ParseUUIDPipe()) id: string, @Body() b: { motivo?: string }): Promise<{ ok: true }> {
    return this.firmas.anular(id, String(b?.motivo ?? ''));
  }
}
