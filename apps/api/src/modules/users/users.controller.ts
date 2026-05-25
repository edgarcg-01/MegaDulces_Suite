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
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { ReqUser } from '../../shared/decorators/req-user.decorator';
import { Permission } from '../../shared/constants/permissions';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

interface AuthUser {
  sub: string;
  username?: string;
  rules?: unknown[];
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  create(@Body() createUserDto: CreateUserDto, @ReqUser() user: AuthUser) {
    return this.usersService.create(createUserDto, user);
  }

  @Get()
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'activo', required: false, enum: ['true', 'false'] })
  findAll(
    @ReqUser() user: AuthUser,
    @Query('zona') zona?: string,
    @Query('activo') activo?: string,
  ) {
    return this.usersService.findAll(zona, activo, user);
  }

  @Get('roles')
  // Sin @RequirePermissions: consumido por selects en múltiples módulos.
  getRoles() {
    return this.usersService.getRoles();
  }

  @Get('supervisors')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiQuery({ name: 'zona', required: false })
  getSupervisors(@Query('zona') zona?: string) {
    return this.usersService.findSupervisors(zona);
  }

  @Get('sellers')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'supervisor_id', required: false })
  @ApiOperation({ summary: 'Obtener vendedores/ejecutivos activos' })
  getSellers(
    @Query('zona') zona?: string,
    @Query('supervisor_id') supervisorId?: string,
  ) {
    return this.usersService.findSellers(zona, supervisorId);
  }

  @Get('supervisor/:id/team')
  @RequirePermissions(Permission.USUARIOS_VER)
  getTeamBySupervisor(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.findBySupervisor(id);
  }

  @Get('zones')
  // Sin @RequirePermissions: consumido por seguimiento, daily-assignments, stores.
  @ApiOperation({ summary: 'Obtener zonas únicas de usuarios activos' })
  getZones() {
    return this.usersService.getZones();
  }

  @Get(':id')
  @RequirePermissions(Permission.USUARIOS_VER)
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.findOne(id, user);
  }

  @Put(':id')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateUserDto: UpdateUserDto,
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.update(id, updateUserDto, user);
  }

  @Delete(':id')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.remove(id, user);
  }
}
