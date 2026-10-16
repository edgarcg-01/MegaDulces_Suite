import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  HrAltaPersonaBody, HrDesligarBody, HrLigarBody, HrLigarResultadoDto, HrPersonaBuscadaDto, HrSinPersonaResponse,
} from '@megadulces/contracts';
import { HrAttendanceEnrollmentsService } from './attendance-enrollments.service';

/**
 * Fase RH · `[RH.1.12]` — ligar códigos de reloj a personas (la bandeja de `/rh/relojes`).
 * Leer: `HR_ATTENDANCE_VER` o `HR_DEVICES_GESTIONAR`. Escribir: `HR_DEVICES_GESTIONAR`, la misma clave que administra
 * los relojes y que ya tiene `recursos_humanos` (`20261008094815`): no hace falta repartir una clave nueva.
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance/enrollments')
export class HrAttendanceEnrollmentsController {
  constructor(private readonly enrollments: HrAttendanceEnrollmentsService) {}

  @Get('unlinked')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — códigos que checan sin persona, con los candidatos que propone el motor de personas.' })
  sinPersona(): Promise<HrSinPersonaResponse> {
    return this.enrollments.sinPersona();
  }

  @Get('people')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — buscar a una persona de la Suite por nombre, para ligarle un código.' })
  buscar(@Query('q') q?: string): Promise<HrPersonaBuscadaDto[]> {
    return this.enrollments.buscar(String(q ?? ''));
  }

  @Post(':id/link')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — ligar el código a una persona (en todos los relojes de su plaza). No pisa otro enlace sin reemplazar.' })
  ligar(@Param('id') id: string, @Body() b: HrLigarBody): Promise<HrLigarResultadoDto> {
    return this.enrollments.ligar(id, b);
  }

  @Post(':id/unlink')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — desligar el código de su persona (con motivo).' })
  desligar(@Param('id') id: string, @Body() b: HrDesligarBody): Promise<{ enrolamientos: number }> {
    return this.enrollments.desligar(id, b?.motivo);
  }

  @Post(':id/register')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — dar de alta a la persona (sin contraseña ni acceso) con su sección, y ligarle el código.' })
  alta(@Param('id') id: string, @Body() b: HrAltaPersonaBody): Promise<HrLigarResultadoDto> {
    return this.enrollments.alta(id, b);
  }
}
