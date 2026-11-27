import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AgendaCitas, AgendarReunionDto, CancelarReunionDto, DetalleReunion, MinutaReunionDto, OpcionesCitas, ProveedoresCitas, ReunionGuardada,
} from '@megadulces/contracts';
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import type { Quien } from './supplier-meetings.repo';
import { SupplierMeetingsService } from './supplier-meetings.service';

export interface Sesion {
  user?: { sub?: string; username?: string };
}

/** Quién escribe, del JWT. Sin usuario no se adivina: se rechaza antes de tocar la base. `[PQ.3.10]` Acuerdos la usa también. */
export const quien = (req: Sesion): Quien => {
  const userId = String(req?.user?.sub ?? '');
  if (!userId) throw new BadRequestException('No sabemos quién eres: vuelve a entrar.');
  return { userId, username: req?.user?.username ?? null };
};

/**
 * `[PQ.3.8]` Compras › Proveedores › Citas (anexo C §9.1, DC41). Leer con cualquiera de las dos llaves (quien agenda
 * también lee); agendar, editar, confirmar, escribir la minuta y cancelar, sólo con `COMPRAS_CITAS_AGENDAR`.
 */
@ApiTags('compras-citas')
@Controller('compras/proveedores/citas')
export class SupplierMeetingsController {
  constructor(private readonly service: SupplierMeetingsService) {}

  @Get()
  @RequireAnyPermission(Permission.COMPRAS_CITAS_VER, Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: la semana de reuniones con proveedores (lunes a domingo) y las que pasaron sin minuta' })
  agenda(@Query('semana') semana?: string): Promise<AgendaCitas> {
    return this.service.agenda(semana);
  }

  @Get('opciones')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: quién puede ir por Mega Dulces (quien ve la agenda), con el área que propone su puesto' })
  opciones(): Promise<OpcionesCitas> {
    return this.service.opciones();
  }

  @Get('proveedores')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: buscar el proveedor de la reunión por nombre o clave (buscador común)' })
  proveedores(@Query('q') q?: string): Promise<ProveedoresCitas> {
    return this.service.proveedores(q);
  }

  @Get(':id')
  @RequireAnyPermission(Permission.COMPRAS_CITAS_VER, Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: una reunión, con quién choca a esa hora y la minuta de la anterior con el mismo proveedor' })
  detalle(@Param('id', ParseUUIDPipe) id: string): Promise<DetalleReunion> {
    return this.service.detalle(id);
  }

  @Post()
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: agendar una reunión con un proveedor (agendada o por confirmar), con su gente y sus temas' })
  agendar(@Body() dto: AgendarReunionDto, @Req() req: Sesion): Promise<ReunionGuardada> {
    return this.service.agendar(quien(req), dto);
  }

  @Post(':id/editar')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: reprogramar o cambiar una reunión abierta (la lista de participantes que llega es la completa)' })
  editar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AgendarReunionDto, @Req() req: Sesion): Promise<ReunionGuardada> {
    return this.service.editar(quien(req), id, dto);
  }

  @Post(':id/confirmar')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: el ejecutivo confirmó: de «por confirmar» a «agendada»' })
  confirmar(@Param('id', ParseUUIDPipe) id: string, @Req() req: Sesion): Promise<{ id: string }> {
    return this.service.confirmar(quien(req), id);
  }

  @Post(':id/minuta')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: escribir la minuta: la reunión queda realizada (con quién y cuándo la escribió)' })
  minuta(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MinutaReunionDto, @Req() req: Sesion): Promise<{ id: string }> {
    return this.service.minuta(quien(req), id, dto);
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.8: cancelar una reunión abierta, con motivo (nada se borra)' })
  cancelar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelarReunionDto, @Req() req: Sesion): Promise<{ id: string }> {
    return this.service.cancelar(quien(req), id, dto);
  }
}
