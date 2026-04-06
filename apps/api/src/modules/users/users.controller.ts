import { Controller, Get, Post, Body, Put, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'activo', required: false, enum: ['true', 'false'] })
  findAll(@Query('zona') zona?: string, @Query('activo') activo?: string) {
    return this.usersService.findAll(zona, activo);
  }


  @Get('roles')
  getRoles() {
    return this.usersService.getRoles();
  }

  @Get('supervisors')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiQuery({ name: 'zona', required: false })
  getSupervisors(@Query('zona') zona?: string) {
    return this.usersService.findSupervisors(zona);
  }

  @Get('supervisor/:id/team')
  @RequirePermissions(Permission.USUARIOS_VER)
  getTeamBySupervisor(@Param('id') id: string) {
    return this.usersService.findBySupervisor(id);
  }

  @Get(':id')
  @RequirePermissions(Permission.USUARIOS_VER)
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Put(':id')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }

  
}