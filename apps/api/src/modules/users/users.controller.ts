import { Controller, Get, Post, Body, Put, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';

@ApiTags('users')
@ApiBearerAuth()
//@UseGuards(RequireAuthGuard, RolesGuard)
//@Roles('superadmin')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get()
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'activo', required: false, enum: ['true', 'false'] })
  findAll(@Query('zona') zona?: string, @Query('activo') activo?: string) {
    return this.usersService.findAll(zona, activo);
  }


  @Get('roles')
  getRoles() {
    return this.usersService.getRoles();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }

  
}