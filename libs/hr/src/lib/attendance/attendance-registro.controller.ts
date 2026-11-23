import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RolesGuard } from '@megadulces/platform-core';
import type { HrRegistroLegalDto } from '@megadulces/contracts';
import { HrAttendanceRegistroService } from './attendance-registro.service';

/**
 * Fase RH · `[RH.15.9]` — El registro de la jornada de una persona, para la autoridad (LFT 132-XXXIV, 804-III).
 * Lo baja quien ve la asistencia (las mismas llaves que la pantalla). Controlador propio: ver `attendance-signoffs`.
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance/registro')
export class HrAttendanceRegistroController {
  constructor(private readonly registro: HrAttendanceRegistroService) {}

  @Get()
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR)
  @ApiOperation({ summary: 'RH — las checadas de una persona tal como las entregó el reloj, en CSV con su huella sha256 (hasta 400 días).' })
  bajar(@Query() q: { site_code?: string; person_code?: string; date_from?: string; date_to?: string }): Promise<HrRegistroLegalDto> {
    return this.registro.registro(q);
  }
}
