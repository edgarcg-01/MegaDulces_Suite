import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { DailyAssignmentsService } from './daily-assignments.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { CreateMyAssignmentDto } from './dto/create-my-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { ReqUser } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

interface AuthUser {
  sub: string;
  username?: string;
  rules?: unknown[];
}

@ApiTags('daily-assignments')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('daily-assignments')
export class DailyAssignmentsController {
  constructor(private readonly service: DailyAssignmentsService) {}

  @Post()
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  create(@Body() dto: CreateAssignmentDto, @ReqUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Get()
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  @ApiQuery({ name: 'supervisor_id', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'day_of_week', required: false, type: Number })
  findAll(
    @ReqUser() user: AuthUser,
    @Query('supervisor_id') supervisorId?: string,
    @Query('user_id') userId?: string,
    @Query('day_of_week') dayOfWeek?: string,
  ) {
    return this.service.findAll(
      {
        supervisor_id: supervisorId,
        user_id: userId,
        day_of_week: dayOfWeek ? parseInt(dayOfWeek, 10) : undefined,
      },
      user,
    );
  }

  // ── Self-service (colaborador/vendedor se asigna su propia ruta) ──────────
  // Gateado por VISITAS_REGISTRAR (quien captura), NO por USUARIOS_ASIGNAR_RUTA
  // (que es del supervisor). El service fuerza user_id = requester.sub, así que
  // un usuario solo puede leer/escribir su propia asignación.

  @Get('me')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiQuery({ name: 'day_of_week', required: false, type: Number })
  findMine(
    @ReqUser() user: AuthUser,
    @Query('day_of_week') dayOfWeek?: string,
  ) {
    return this.service.findMine(
      dayOfWeek ? parseInt(dayOfWeek, 10) : undefined,
      user,
    );
  }

  @Post('me')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  createMine(@Body() dto: CreateMyAssignmentDto, @ReqUser() user: AuthUser) {
    return this.service.create({ ...dto, user_id: user.sub }, user);
  }

  @Get(':id')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqUser() user: AuthUser,
  ) {
    return this.service.findOne(id, user);
  }

  @Put(':id')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAssignmentDto,
    @ReqUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @RequirePermissions(Permission.USUARIOS_ASIGNAR_RUTA)
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqUser() user: AuthUser,
  ) {
    return this.service.remove(id, user);
  }
}
