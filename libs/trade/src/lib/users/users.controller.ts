import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RequireAuthGuard } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { ReqUser } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { ScopeService, TenantContextService } from '@megadulces/platform-core';
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
  constructor(
    private readonly usersService: UsersService,
    private readonly scope: ScopeService,
    private readonly tenantCtx: TenantContextService,
  ) {}

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

  @Get('departments')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Catálogo de departamentos del organigrama (eje organizacional)' })
  getDepartments() {
    return this.usersService.getDepartments();
  }

  @Get('positions')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Catálogo de puestos canonicalizados del ORGANIGRAMA 2026' })
  getPositions() {
    return this.usersService.getPositions();
  }

  /**
   * `[ID.2]` — Alcance del usuario en sesión (Fase ID / ADR-050).
   *
   * Declarado ANTES de `:id`: si fuera después, la ruta genérica se tragaría
   * `me/scope` (mismo cuidado que en sales-documents con `:folio/anexo.pdf`).
   *
   * SIN `@RequirePermissions`: cualquiera puede preguntar por su PROPIO alcance
   * — es lo que alimenta los selectores de sucursal del front, y pedir un
   * permiso para saber qué puedes ver es circular.
   */
  @Get('me/scope')
  @ApiOperation({ summary: 'Alcance de datos del usuario en sesión, por dimensión, con las opciones que puede elegir' })
  async myScope() {
    const scope = await this.scope.current();
    return {
      user_id: scope.userId,
      role_name: scope.roleName,
      dimensions: await this.scope.describe(scope),
    };
  }

  /** `[ID.2]` — Alcance de OTRO usuario, para el panel "Acceso efectivo" del admin. */
  @Get(':id/scope')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Alcance efectivo de un usuario y de dónde sale cada dimensión (user override / rol / default)' })
  async userScope(@Param('id', new ParseUUIDPipe()) id: string) {
    const scope = await this.scope.forUser(this.tenantCtx.requireTenantId(), id);
    return {
      user_id: scope.userId,
      role_name: scope.roleName,
      dimensions: await this.scope.describe(scope),
    };
  }

  /**
   * `[ID.9]` — Editar el ALCANCE de un usuario desde la UI.
   *
   * Hasta acá `identity.user_scopes` sólo se podía tocar por migración, o sea
   * que ampliar o recortar lo que alguien ve exigía una sesión con acceso a prod.
   * Regla de Edgar: el dato operativo se administra en /admin/*.
   *
   * `mode: null` borra el override y el usuario vuelve al default de su rol —
   * distinto de `mode: 'none'`, que es "explícitamente no ve nada".
   */
  @Put(':id/scope/:dimension')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Fija (o borra, con mode=null) el alcance de un usuario en una dimensión. Queda asentado en identity.user_events.' })
  setScope(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('dimension') dimension: string,
    @Body() body: { mode?: string | null; values?: string[] | null; mode_write?: string | null; nota?: string | null },
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.setScope(id, dimension, body ?? {}, { sub: user.sub, username: user.username });
  }

  /**
   * `[ID.9]` — Asignación MASIVA de los ejes de control (departamento, puesto,
   * sucursal, estado). Es lo que evita el script: normalizar 116 usuarios de a
   * uno por pantalla no es viable, y por eso el dato se quedaba viejo.
   */
  @Patch('bulk')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Asigna departamento / puesto / sucursal / estado a varios usuarios de una vez. Un evento por usuario.' })
  bulkAssign(
    @Body() body: { user_ids: string[]; department_code?: string | null; position_code?: string | null; warehouse_code?: string | null; status?: string | null },
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.bulkAssign(body, { sub: user.sub, username: user.username });
  }

  /** `[ID.9]` — Bitácora del usuario: quién le cambió qué y cuándo. */
  @Get(':id/events')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Últimos cambios registrados del usuario (identity.user_events)' })
  events(@Param('id', new ParseUUIDPipe()) id: string, @Query('limit') limit?: string) {
    return this.usersService.events(id, limit ? Number(limit) : undefined);
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
