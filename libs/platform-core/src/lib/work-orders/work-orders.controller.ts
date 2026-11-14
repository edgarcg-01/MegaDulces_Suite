import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CambiosTrabajoVale, FirmarVale, ListaVales, NuevoVale, ValeDetalle } from '@megadulces/contracts';
import { RolesGuard } from '../guards/roles.guard';
import { RequireAnyPermission } from '../decorators/permissions.decorator';
import { Permission } from '../constants/permissions';
import { isPlatformAdminRole } from '../ability/platform-admin';
import { WorkOrdersService, type Llaves } from './work-orders.service';

interface UsuarioDeLaPeticion {
  permissions?: Record<string, boolean>;
  roles_frescos?: string[];
}

const CUALQUIER_LLAVE = [Permission.VALE_SERVICIO_LEVANTAR, Permission.VALE_SERVICIO_ATENDER, Permission.VALE_SERVICIO_GESTIONAR] as const;

/**
 * `[MDT.2.3]` Vale de servicio (Fase MDT, D8/D8b). Toda ruta pide ALGUNA de las tres llaves; lo que cada
 * quien puede hacer sobre un vale lo decide el servidor con la fila (asignado, solicitante) y la llave
 * (atender, coordinar), con las reglas del contrato. Ninguna ruta borra: un vale se cancela.
 */
@ApiTags('work-orders')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('work-orders')
export class WorkOrdersController {
  constructor(private readonly service: WorkOrdersService) {}

  @Get()
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Vales: ?scope=mine|queue|all (lo permitido lo decide la llave) y ?q= (folio, área, actividad, quién pidió)' })
  lista(@Req() req: { user?: UsuarioDeLaPeticion }, @Query('scope') scope?: string, @Query('q') q?: string): Promise<ListaVales> {
    return this.service.lista(this.llaves(req), scope, q);
  }

  @Get('assignees')
  @RequireAnyPermission(Permission.VALE_SERVICIO_GESTIONAR)
  @ApiOperation({ summary: 'A quién se puede asignar un vale: personas activas con alguna llave de vales' })
  responsables(@Query('q') q?: string): Promise<{ id: string; nombre: string; puesto: string | null }[]> {
    return this.service.responsables(q);
  }

  @Get(':id')
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Un vale con su trabajo, firmas (URL firmada), historial y lo que puedo hacer ahora' })
  detalle(@Param('id') id: string, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.detalle(id, this.llaves(req));
  }

  @Post()
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Levanta un vale. Body: `{ requesting_area, activity, warehouse_code?, location_detail?, requester_name?, supervisor_id? }`' })
  crear(@Body() body: NuevoVale, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.crear(body, this.llaves(req));
  }

  @Post(':id/take')
  @RequireAnyPermission(Permission.VALE_SERVICIO_ATENDER, Permission.VALE_SERVICIO_GESTIONAR)
  @ApiOperation({ summary: 'Toma un vale ABIERTO: queda a mi nombre y en proceso' })
  tomar(@Param('id') id: string, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.tomar(id, this.llaves(req));
  }

  @Post(':id/assign')
  @RequireAnyPermission(Permission.VALE_SERVICIO_GESTIONAR)
  @ApiOperation({ summary: 'Asigna o reasigna. Body: `{ user_id }` — alguien que pueda abrir los vales' })
  asignar(@Param('id') id: string, @Body() body: { user_id?: string }, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.asignar(id, body, this.llaves(req));
  }

  @Patch(':id')
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Captura el trabajo (detalle, materiales, resultado, notas, seguimiento). El asignado o quien coordina' })
  guardar(@Param('id') id: string, @Body() body: CambiosTrabajoVale, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.guardarTrabajo(id, body, this.llaves(req));
  }

  @Post(':id/complete')
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Cierra el vale. Exige el trabajo escrito (puede venir en el body); ninguna firma es obligatoria' })
  completar(@Param('id') id: string, @Body() body: CambiosTrabajoVale, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.completar(id, body, this.llaves(req));
  }

  @Post(':id/cancel')
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Cancela con motivo. Body: `{ reason }`. Quien coordina, o quien lo pidió mientras sigue abierto' })
  cancelar(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.cancelar(id, body, this.llaves(req));
  }

  @Post(':id/reopen')
  @RequireAnyPermission(Permission.VALE_SERVICIO_GESTIONAR)
  @ApiOperation({ summary: 'Reabre un vale cerrado con motivo. Body: `{ reason }`. El cierre anterior queda en el historial' })
  reabrir(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.reabrir(id, body, this.llaves(req));
  }

  @Post(':id/signatures')
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Agrega una firma. Body: `{ role: performed|reviewed|received, signer_name, image_base64 }`' })
  firmar(@Param('id') id: string, @Body() body: FirmarVale, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.firmar(id, body, this.llaves(req));
  }

  @Delete(':id/signatures/:signatureId')
  @RequireAnyPermission(...CUALQUIER_LLAVE)
  @ApiOperation({ summary: 'Quita (aparta) una firma. Nunca de un vale completado' })
  quitarFirma(@Param('id') id: string, @Param('signatureId') signatureId: string, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<ValeDetalle> {
    return this.service.quitarFirma(id, signatureId, this.llaves(req));
  }

  /** Las llaves de ESTA persona (god-mode cuenta como coordinar). La fila decide el resto en el servicio. */
  private llaves(req: { user?: UsuarioDeLaPeticion }): Llaves {
    const u = req?.user;
    const admin = (u?.roles_frescos ?? []).some((r) => isPlatformAdminRole(r));
    return {
      atender: admin || u?.permissions?.[Permission.VALE_SERVICIO_ATENDER] === true,
      gestionar: admin || u?.permissions?.[Permission.VALE_SERVICIO_GESTIONAR] === true,
    };
  }
}
