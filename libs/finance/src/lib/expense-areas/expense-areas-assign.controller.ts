import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ExpenseAreasAssignService, type AsignacionPedida } from './expense-areas-assign.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * `[GX.16]` — Asignación asistida de áreas de gasto.
 *
 * Gateado con `USUARIOS_GESTIONAR` y no con un permiso nuevo: lo que se escribe es un
 * campo de `users`, y quien administra usuarios ya podía hacer esto mismo diálogo por
 * diálogo. Un permiso nuevo exigiría migración y re-login para no darle a nadie nada que
 * no tuviera ya.
 */
@ApiTags('finance-expense-areas')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/expenses/areas')
export class ExpenseAreasAssignController {
  constructor(private readonly svc: ExpenseAreasAssignService) {}

  @Get('asignacion')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: '[GX.16] Quién captura o revisa gastos, qué áreas tiene hoy y cuál se le propone. La propuesta exige que el nombre del área esté contenido ENTERO en el de la persona: aflojarla propone el área de un homónimo.' })
  estado(@Query('dias') dias?: string) {
    return this.svc.estado(dias ? Number(dias) : undefined);
  }

  @Post('asignacion')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: '[GX.16] Aplica las asignaciones confirmadas. Reemplaza la lista completa de cada usuario (sirve para agregar y para quitar).' })
  asignar(@Body() body: { asignaciones?: AsignacionPedida[] }, @Req() req?: AuthedRequest) {
    return this.svc.asignar(body?.asignaciones || [], req?.user?.full_name || req?.user?.username);
  }
}
