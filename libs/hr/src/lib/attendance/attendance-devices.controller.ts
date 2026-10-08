import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import { HrAttendanceDevicesService, type RelojDto } from './attendance-devices.service';

/**
 * Fase RH · `[RH.1.2]` — administrar los relojes checadores (lo que usa la pantalla `/rh/relojes`).
 * Leer: `HR_ATTENDANCE_VER` o `HR_DEVICES_GESTIONAR`. Escribir: `HR_DEVICES_GESTIONAR`, que va
 * fuera de los grupos «de paquete»: una orden a un reloj se ejecuta en el equipo de una plaza.
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/attendance/devices')
export class HrAttendanceDevicesController {
  constructor(private readonly devices: HrAttendanceDevicesService) {}

  @Get()
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — el padrón de relojes checadores.' })
  listar() {
    return this.devices.listar();
  }

  @Get('status')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — semáforo de cada reloj (última señal del lector).' })
  estado() {
    return this.devices.estado();
  }

  @Get('pending-batches')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — lotes que llegaron y no se aplicaron (serie sin registrar, reloj en pausa).' })
  lotesPendientes() {
    return this.devices.lotesPendientes();
  }

  @Get('commands')
  @RequireAnyPermission(Permission.HR_ATTENDANCE_VER, Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — relojes del sitio y órdenes recientes.' })
  ordenes(@Query() q: { site_code?: string; person_code?: string }) {
    return this.devices.ordenes(q);
  }

  @Post('commands/rename')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — renombrar a una persona en los relojes del sitio (vía el agente).' })
  renombrar(@Body() b: { site_code?: string; person_code?: string; name?: unknown }) {
    return this.devices.renombrar(b);
  }

  @Post('commands/restore')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — volver a dar de alta en los relojes a alguien borrado, con su respaldo.' })
  restaurar(@Body() b: { site_code?: string; person_code?: string }) {
    return this.devices.restaurar(b);
  }

  @Post('commands/:id/cancel')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — cancelar una orden mientras siga pendiente.' })
  cancelar(@Param('id') id: string) {
    return this.devices.cancelar(id);
  }

  @Put(':serial')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — alta o edición de un reloj (sitio, IP, modo, pausa).' })
  guardar(@Param('serial') serial: string, @Body() b: RelojDto) {
    return this.devices.guardar(serial, b);
  }

  @Post(':serial/reprocess')
  @RequirePermissions(Permission.HR_DEVICES_GESTIONAR)
  @ApiOperation({ summary: 'RH — aplicar los lotes guardados de un reloj ya dado de alta o fuera de pausa.' })
  reprocesar(@Param('serial') serial: string) {
    return this.devices.reprocesar(serial);
  }
}
