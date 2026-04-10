import { Controller, Post, UseGuards } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('cron')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('cron')
export class CronController {
  constructor(private readonly tasksService: TasksService) {}

  @Post('cleanup')
  @ApiOperation({ summary: 'Ejecuta manualmente la limpieza de imágenes antiguas (más de 30 días)' })
  async manualCleanup() {
    await this.tasksService.manualCleanup();
    return { message: 'Cleanup task executed successfully' };
  }
}
