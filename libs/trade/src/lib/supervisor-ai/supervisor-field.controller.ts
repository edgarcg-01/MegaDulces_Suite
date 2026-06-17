import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReqUser, RequireAuthGuard } from '@megadulces/platform-core';
import { SupervisorActionsService } from './supervisor-actions.service';

/**
 * Horus — endpoints FIELD-FACING (Batch 2 / #1: cerrar el loop al campo).
 *
 * El colaborador VE y ACUSA su coaching/tareas. Estrictamente SELF-SCOPED por
 * JWT.sub + tenant → solo `RequireAuthGuard` (sin permiso de dominio ni RolesGuard):
 * un usuario jamás ve ni acusa nada que no sea suyo (los queries filtran
 * collaborator_id/assigned_to_user = sub). Esto evita el backfill de permisos +
 * re-login y funciona para CUALQUIER captor (vendedor, supervisor, colaborador),
 * no solo el rol vendedor — cerrando el caveat de "captores no-vendedores".
 */
@ApiTags('supervisor-ai-field')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('supervisor-ai/field')
export class SupervisorFieldController {
  constructor(private readonly actions: SupervisorActionsService) {}

  @Get('my-tasks')
  @ApiOperation({ summary: 'Tareas de campo asignadas al usuario autenticado (self-scoped)' })
  myTasks(@ReqUser() user: any) {
    return this.actions.myTasks(user);
  }

  @Get('my-coaching')
  @ApiOperation({ summary: 'Notas de coaching dirigidas al usuario autenticado (self-scoped)' })
  myCoaching(@ReqUser() user: any) {
    return this.actions.myCoaching(user);
  }

  @Post('tasks/:id/ack')
  @ApiOperation({ summary: 'El colaborador marca su tarea como hecha (acuse de recibo)' })
  ackTask(@ReqUser() user: any, @Param('id') id: string) {
    return this.actions.ackTask(id, user);
  }

  @Post('coaching/:id/ack')
  @ApiOperation({ summary: 'El colaborador marca su coaching como visto (acuse de recibo)' })
  ackCoaching(@ReqUser() user: any, @Param('id') id: string) {
    return this.actions.ackCoaching(id, user);
  }
}
