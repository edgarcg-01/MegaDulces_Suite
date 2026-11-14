import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AbrirEntrega, AvanceDelEquipo, DetalleEntrega, EntregarChecklist, GuardarPunto, MisTareas, NormaTarea,
  NuevaVersionNorma, SubirEvidencia,
} from '@megadulces/contracts';
import { RolesGuard } from '../guards/roles.guard';
import { RequireAnyPermission, RequirePermissions } from '../decorators/permissions.decorator';
import { Permission } from '../constants/permissions';
import { isPlatformAdminRole } from '../ability/platform-admin';
import { ChecklistsService } from './checklists.service';

interface UsuarioDeLaPeticion {
  permissions?: Record<string, boolean>;
  roles_frescos?: string[];
}

/**
 * `[MDT.2.*]` — Tareas por puesto (Fase MDT): el manual de cada puesto, entregado con evidencia.
 *
 * Tres llaves, tres oficios:
 *  · `TAREAS_PUESTO_ENTREGAR` — mis tareas del día: abrir, capturar, subir evidencia, entregar. El
 *    servidor exige además ser el DUEÑO de la entrega: la llave abre la puerta, la fila decide.
 *  · `TAREAS_PUESTO_EQUIPO_VER` — el avance de mi gente (cadena de mando y sucursal) y leer sus
 *    entregas. No escribe por ellos.
 *  · `TAREAS_PUESTO_NORMA_GESTIONAR` — cambiar los puntos del manual (versión nueva, no pisa).
 */
@ApiTags('checklists')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('checklists')
export class ChecklistsController {
  constructor(private readonly service: ChecklistsService) {}

  @Get('mine')
  @RequirePermissions(Permission.TAREAS_PUESTO_ENTREGAR)
  @ApiOperation({ summary: 'Mis tareas del manual de un día (hoy por omisión), DERIVADAS de la norma de mi puesto' })
  mias(@Query('date') date?: string): Promise<MisTareas> {
    return this.service.misTareas(date || undefined);
  }

  @Post('runs')
  @RequirePermissions(Permission.TAREAS_PUESTO_ENTREGAR)
  @ApiOperation({
    summary: 'Abre (o devuelve) mi entrega de una tarea para un día. Idempotente',
    description: 'Body: `{ template_id, period_date (AAAA-MM-DD) }`. Hasta 7 días atrás (entrega tardía).',
  })
  abrir(@Body() body: AbrirEntrega): Promise<DetalleEntrega> {
    return this.service.abrir(body);
  }

  @Get('runs/:id')
  @RequireAnyPermission(Permission.TAREAS_PUESTO_ENTREGAR, Permission.TAREAS_PUESTO_EQUIPO_VER)
  @ApiOperation({ summary: 'Una entrega con sus puntos, evidencia (URL firmada) y estado. La mía, o la de mi equipo' })
  detalle(@Param('id') id: string, @Req() req: { user?: UsuarioDeLaPeticion }): Promise<DetalleEntrega> {
    return this.service.detalle(id, this.puedeVerEquipo(req));
  }

  @Patch('runs/:id/items/:itemId')
  @RequirePermissions(Permission.TAREAS_PUESTO_ENTREGAR)
  @ApiOperation({
    summary: 'Guarda lo capturado en un punto de MI entrega abierta',
    description: 'Body: `{ checked?, text?, list?, amount?, folio?, comment? }`.',
  })
  guardarPunto(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: GuardarPunto): Promise<DetalleEntrega> {
    return this.service.guardarPunto(id, itemId, body);
  }

  @Post('runs/:id/items/:itemId/files')
  @RequirePermissions(Permission.TAREAS_PUESTO_ENTREGAR)
  @ApiOperation({
    summary: 'Sube una foto (o PDF si el punto acepta documentos) a un punto de MI entrega abierta',
    description: 'Body: `{ file_base64 (data URI), file_name?, captured_at? }`. El tipo se valida por la firma del archivo. Máx. 10 MB.',
  })
  subir(@Param('id') id: string, @Param('itemId') itemId: string, @Body() body: SubirEvidencia): Promise<DetalleEntrega> {
    return this.service.subirEvidencia(id, itemId, body);
  }

  @Delete('runs/:id/files/:fileId')
  @RequirePermissions(Permission.TAREAS_PUESTO_ENTREGAR)
  @ApiOperation({ summary: 'Retira un archivo de MI entrega abierta (queda como rastro, no se borra)' })
  retirar(@Param('id') id: string, @Param('fileId') fileId: string): Promise<DetalleEntrega> {
    return this.service.retirarArchivo(id, fileId);
  }

  @Post('runs/:id/submit')
  @RequirePermissions(Permission.TAREAS_PUESTO_ENTREGAR)
  @ApiOperation({
    summary: 'Entrega. Con todo hecho, o con una nota que explique lo que falta (eso queda justificado, no hecho)',
    description: 'Body: `{ employee_note? }`.',
  })
  entregar(@Param('id') id: string, @Body() body: EntregarChecklist): Promise<DetalleEntrega> {
    return this.service.entregar(id, body);
  }

  @Get('team')
  @RequirePermissions(Permission.TAREAS_PUESTO_EQUIPO_VER)
  @ApiOperation({ summary: 'El avance de un día de la gente a mi cargo (cadena de mando y, si tengo una, mi sucursal)' })
  equipo(@Query('date') date?: string): Promise<AvanceDelEquipo> {
    return this.service.equipo(date || undefined);
  }

  @Get('norms')
  @RequireAnyPermission(Permission.TAREAS_PUESTO_EQUIPO_VER, Permission.TAREAS_PUESTO_NORMA_GESTIONAR)
  @ApiOperation({ summary: 'El manual: tareas de un puesto (?position_code=) o todas, con la versión que rige hoy' })
  normas(@Query('position_code') positionCode?: string): Promise<NormaTarea[]> {
    return this.service.normas(positionCode || undefined);
  }

  @Post('norms/:id/versions')
  @RequirePermissions(Permission.TAREAS_PUESTO_NORMA_GESTIONAR)
  @ApiOperation({
    summary: 'Cambia los puntos de una tarea del manual: agrega una versión con fecha y motivo',
    description: 'Body: `{ items, change_note, valid_from? }`. valid_from no puede ser pasado.',
  })
  nuevaVersion(@Param('id') id: string, @Body() body: NuevaVersionNorma): Promise<NormaTarea> {
    return this.service.nuevaVersion(id, body);
  }

  private puedeVerEquipo(req: { user?: UsuarioDeLaPeticion }): boolean {
    const u = req?.user;
    return (u?.roles_frescos ?? []).some((r) => isPlatformAdminRole(r))
      || u?.permissions?.[Permission.TAREAS_PUESTO_EQUIPO_VER] === true;
  }
}
