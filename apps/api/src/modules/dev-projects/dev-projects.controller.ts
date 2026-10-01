import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import { DevProjectsService, type UploadedFileLike } from './dev-projects.service';
import { MAX_ATTACHMENT_BYTES, type DevProjectInput } from './dev-projects.rules';

/**
 * `[DEV.3]` Desarrolladores › Proyectos — `/api/dev/projects`.
 *
 * Leer pide `DEV_PROJECTS_VER` **o** `_GESTIONAR` (quien da de alta también tiene que poder ver lo
 * que dio de alta); escribir pide `_GESTIONAR`. JWT y `RolesGuard` son globales (`AppModule`).
 *
 * ⚠️ Los adjuntos van por **multipart** y no por JSON en base64: el límite global de JSON es 2 MB
 * y un video no cabe. El tope por archivo lo pone multer (`MAX_ATTACHMENT_BYTES`); en prod el
 * proxy (`client_max_body_size`) tiene que permitir al menos eso o el video rebota antes de llegar.
 */
@ApiTags('dev-projects')
@Controller('dev/projects')
export class DevProjectsController {
  constructor(private readonly svc: DevProjectsService) {}

  @Get('team')
  @RequireAnyPermission(Permission.DEV_PROJECTS_VER, Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Equipo de desarrollo al que se le puede asignar un proyecto.' })
  team() {
    return this.svc.team();
  }

  @Get()
  @RequireAnyPermission(Permission.DEV_PROJECTS_VER, Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Lista de proyectos (filtros: status, assignee, search).' })
  list(@Query('status') status?: string, @Query('assignee') assignee?: string, @Query('search') search?: string) {
    return this.svc.list({ status, assignee, search });
  }

  @Get(':id')
  @RequireAnyPermission(Permission.DEV_PROJECTS_VER, Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Detalle del proyecto con sus adjuntos (URL prefirmada temporal).' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.detail(id);
  }

  @Post()
  @RequirePermissions(Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Da de alta un proyecto (genera folio DEV-AAAA-NNNN).' })
  create(@Body() body: DevProjectInput) {
    return this.svc.create(body);
  }

  @Patch(':id')
  @RequirePermissions(Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Edita nombre, objetivo, prioridad, estado, responsable o fecha compromiso.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: DevProjectInput) {
    return this.svc.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Baja lógica del proyecto (se conserva con deleted_at).' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/attachments')
  @RequirePermissions(Permission.DEV_PROJECTS_GESTIONAR)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES } }))
  @ApiOperation({ summary: 'Adjunta un archivo (documento, foto, video, audio). Campo `source`: archivo|camara|grabacion.' })
  addAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedFileLike,
    @Body('source') source?: string,
  ) {
    return this.svc.addAttachment(id, file, source);
  }

  @Delete(':id/attachments/:attachmentId')
  @RequirePermissions(Permission.DEV_PROJECTS_GESTIONAR)
  @ApiOperation({ summary: 'Quita un adjunto (baja lógica).' })
  removeAttachment(@Param('id', ParseUUIDPipe) id: string, @Param('attachmentId', ParseUUIDPipe) attachmentId: string) {
    return this.svc.removeAttachment(id, attachmentId);
  }
}
