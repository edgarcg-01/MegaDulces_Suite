import { Controller, Post, UseGuards } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { RequireAuthGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('cron')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('cron')
export class CronController {
  constructor(private readonly tasksService: TasksService) {}

  /**
   * `[AUTHZ.5]` — Era sólo-auth: cualquier usuario logueado podía disparar un borrado masivo de
   * imágenes. Pasa a exigir `USUARIOS_GESTIONAR`, que es el permiso que el proyecto ya usa para lo
   * de sistema (`/admin/db-health` lo usa).
   */
  @Post('cleanup')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({
    summary:
      'Ejecuta manualmente la limpieza de imágenes antiguas (más de 30 días)',
  })
  async manualCleanup() {
    await this.tasksService.manualCleanup();
    return { message: 'Cleanup task executed successfully' };
  }
}
