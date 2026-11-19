import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  HrAltaPersonaBody, HrArchivarPersonaBody, HrBajaLoteBody, HrBajaLoteResultadoDto, HrBajaPlazaBody, HrBajaPlazaDto, HrBajaResultadoDto,
  HrCatalogosFichaDto, HrDesligarBody, HrFichaPersonaDto, HrFichaPlazaBody, HrFichaPlazaDto, HrLigarBody, HrLigarResultadoDto,
  HrNombresPorConfirmarResponse, HrPersonaBuscadaDto, HrPosiblesBajasResponse, HrSinPersonaResponse,
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

  @Get('site-profiles/inactive')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — la papelera de una plaza: quién está de baja, desde cuándo, por qué y si sigue checando.' })
  bajas(@Query('site_code') site?: string): Promise<HrBajaPlazaDto[]> {
    return this.enrollments.bajas(String(site ?? ''));
  }

  @Post('site-profile/deactivate')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — dar de baja a una persona EN UNA PLAZA (con motivo): deja de contar en su reporte. Dice si se quedó sin plazas.' })
  darDeBaja(@Body() b: HrBajaPlazaBody): Promise<HrBajaResultadoDto> {
    return this.enrollments.darDeBaja(b);
  }

  @Get('site-profiles/stale')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH [RH.14.6] — posibles bajas: activos en la plaza que llevan N días (31 por omisión) sin checar.' })
  posiblesBajas(@Query('site_code') site?: string, @Query('days') days?: string): Promise<HrPosiblesBajasResponse> {
    return this.enrollments.posiblesBajas(String(site ?? ''), days);
  }

  @Post('site-profile/deactivate-batch')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH [RH.14.6] — varias bajas en una plaza con un motivo; las que fallan no deshacen a las demás.' })
  darDeBajaLote(@Body() b: HrBajaLoteBody): Promise<HrBajaLoteResultadoDto> {
    return this.enrollments.darDeBajaLote(b);
  }

  @Post('person/archive')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH [RH.14.1] — archivar a una persona sin acceso a la Suite que ya no tiene plazas activas.' })
  archivar(@Body() b: HrArchivarPersonaBody): Promise<{ ok: true }> {
    return this.enrollments.archivar(b);
  }

  @Get('site-profile')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH [RH.14.3] — la ficha completa de una persona en una plaza: relojes, ficha y datos de la persona.' })
  ficha(@Query('site_code') site?: string, @Query('person_code') codigo?: string): Promise<HrFichaPersonaDto> {
    return this.enrollments.ficha(String(site ?? ''), String(codigo ?? ''));
  }

  @Get('catalogs')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH [RH.14.5] — departamentos, puestos y sucursales para la ficha de la persona.' })
  catalogos(): Promise<HrCatalogosFichaDto> {
    return this.enrollments.catalogos();
  }

  @Get('names-to-confirm')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH [RH.14.4] — personas activas sin acceso cuyo nombre es el apodo del reloj o tiene menos de 3 palabras.' })
  nombresPorConfirmar(@Query('site_code') site?: string): Promise<HrNombresPorConfirmarResponse> {
    return this.enrollments.nombresPorConfirmar(site);
  }

  @Post('site-profile/reactivate')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — reactivar a una persona en la plaza (sale de la papelera y vuelve al reporte).' })
  reactivar(@Body() b: HrBajaPlazaBody): Promise<{ ok: true }> {
    return this.enrollments.reactivar(b);
  }

  @Put('site-profile')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — corregir la ficha de una persona en una plaza: sección del reporte, promotora y (sin acceso) nombre.' })
  editarFicha(@Body() b: HrFichaPlazaBody): Promise<HrFichaPlazaDto> {
    return this.enrollments.editarFicha(b);
  }

  @Post(':id/register')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — dar de alta a la persona (sin contraseña ni acceso) con su sección, y ligarle el código.' })
  alta(@Param('id') id: string, @Body() b: HrAltaPersonaBody): Promise<HrLigarResultadoDto> {
    return this.enrollments.alta(id, b);
  }
}
