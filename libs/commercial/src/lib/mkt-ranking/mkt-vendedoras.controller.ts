import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, ReqUser, isPlatformAdminRole } from '@megadulces/platform-core';
import { MktVendedorasService } from './mkt-vendedoras.service';
import type { AsignacionDto } from './mkt-vendedoras.service';

interface Usuario { id?: string; username?: string; role_name?: string; permissions?: Record<string, boolean> }

/**
 * `[MKT.18]` — La cajera escribe, desde su arqueo, quién vendió cada ticket con promoción.
 *
 * Sin claves nuevas: lo usa quien ya captura el arqueo (`STORE_ARQUEO_CAPTURAR`, repartida a
 * las cajeras). Ver la sucursal completa sigue la MISMA regla que el arqueo para revelar: el
 * supervisor de cuadre (`RECONCILIATION_VER`) o un admin de plataforma; los demás, sus turnos.
 */
@ApiTags('mkt-ranking')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/mkt-ranking/vendedoras')
export class MktVendedorasController {
  constructor(private readonly service: MktVendedorasService) {}

  private verTodo(u: Usuario | undefined): boolean {
    return isPlatformAdminRole(u?.role_name) || u?.permissions?.[Permission.RECONCILIATION_VER] === true;
  }

  @Get()
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Tickets con promoción de mis turnos (Kepler) y la lista del reloj de la sucursal, para decir quién vendió' })
  tickets(@ReqUser() user: Usuario, @Query('sucursal') sucursal?: string, @Query('dias') dias?: string): ReturnType<MktVendedorasService['tickets']> {
    return this.service.tickets(sucursal, dias, user?.username, this.verTodo(user));
  }

  @Put()
  @RequirePermissions(Permission.STORE_ARQUEO_CAPTURAR)
  @ApiOperation({ summary: 'Guarda quién vendió cada ticket (person_code null = quitar)' })
  guardar(@ReqUser() user: Usuario, @Body() body: { sucursal?: string; items?: AsignacionDto[] }): ReturnType<MktVendedorasService['guardar']> {
    return this.service.guardar(body?.sucursal, body?.items, { id: user?.id, username: user?.username }, this.verTodo(user));
  }
}
