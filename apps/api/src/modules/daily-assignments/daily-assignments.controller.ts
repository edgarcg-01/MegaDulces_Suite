import {
  Controller,
  Get,
  Post,
  Body,
  Put,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DailyAssignmentsService } from './daily-assignments.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

@ApiTags('daily-assignments')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('daily-assignments')
export class DailyAssignmentsController {
  constructor(private readonly service: DailyAssignmentsService) {}

  @Post()
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  create(@Body() dto: CreateAssignmentDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiQuery({ name: 'supervisor_id', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'day_of_week', required: false, type: Number })
  findAll(
    @Query('supervisor_id') supervisorId?: string,
    @Query('user_id') userId?: string,
    @Query('day_of_week') dayOfWeek?: string,
  ) {
    return this.service.findAll({
      supervisor_id: supervisorId,
      user_id: userId,
      day_of_week: dayOfWeek ? parseInt(dayOfWeek, 10) : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Put(':id')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
