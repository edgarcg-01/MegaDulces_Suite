import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
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

  /**
   * `[ID.23]` — Sucursales con su zona. El alta elige sucursal y deriva la zona
   * de acá, en vez de preguntar las dos cosas por separado.
   */
  @Get('branches')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Sucursales (código de 2 dígitos) con la zona que cada una declara' })
  getBranches() {
    return this.usersService.getBranches();
  }

  /**
   * `[ID.24.1]` — Rutas con la zona que implican. Alimenta el selector de ruta
   * de la gente de eje `ruta`, que hasta acá no tenía dónde guardarla.
   */
  @Get('routes')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Rutas del catálogo con su zona derivada y cuántas tiendas trae cada una' })
  getRoutes() {
    return this.usersService.getRoutes();
  }

  @Get('departments')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Catálogo de departamentos del organigrama (eje organizacional)' })
  getDepartments() {
    return this.usersService.getDepartments();
  }

  @Get('positions')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Catálogo de puestos del ORGANIGRAMA 2026, con el departamento y el perfil base que cada uno propone' })
  getPositions() {
    return this.usersService.getPositions();
  }

  /**
   * `[ID.15]` — Qué propone el sistema para un puesto: departamento, perfil base
   * y el alcance que trae ese perfil. Declarado antes de `:id` a propósito.
   */
  @Get('positions/:code/propuesta')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Departamento + perfil base + alcance que el sistema propone para un puesto (el alta ya no adivina)' })
  proposeForPosition(@Param('code') code: string) {
    return this.usersService.proposeForPosition(code);
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

  /**
   * `[ID.21]` — Permisos VIGENTES del usuario en sesión.
   *
   * SIN `@RequirePermissions` y antes de `:id`, por lo mismo que `me/scope`:
   * preguntar por lo tuyo no puede exigir un permiso. Es lo que le permite al
   * front refrescar el menú cuando le cambian el acceso, sin re-login.
   */
  @Get('me/access')
  @ApiOperation({ summary: 'Permisos y reglas vigentes del usuario en sesión (frescos de DB, no del JWT)' })
  async myAccess(@ReqUser() user: AuthUser & { role_name?: string }) {
    const res = await this.usersService.accessFor(user.sub, user.role_name);
    // Nunca contestar un mapa vacío: el front reemplaza su snapshot con esto y
    // se quedaría sin menú. Vacío = algo salió mal (token legacy sin tenant,
    // usuario sin rol) y la respuesta honesta es un error, no "cero permisos".
    if (!res.permissions || Object.keys(res.permissions).length === 0) {
      throw new NotFoundException('No se pudieron resolver los permisos vigentes.');
    }
    return res;
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

  /**
   * `[ID.13]` — Roles del usuario: perfil base + complementos, con el conteo de
   * permisos de cada uno.
   */
  @Get(':id/roles')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Perfil base y complementos de un usuario (identity.user_roles) con sus permisos otorgados' })
  userRoles(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.roles(id);
  }

  /**
   * `[ID.13]` — Fija los COMPLEMENTOS del usuario desde la UI.
   *
   * Semántica de PUT: la lista que llega es la lista final. El perfil base no se
   * cambia acá (eso es `role_name` en el formulario) — así "sumarle una tarea a
   * alguien" y "cambiarle el puesto" quedan como dos acciones distintas, que es
   * lo que son.
   */
  @Put(':id/roles')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Fija los complementos (roles extra) de un usuario. Devuelve qué se agregó y qué se quitó. Queda asentado en identity.user_events.' })
  setUserRoles(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { roles?: string[] },
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.setRoles(id, body?.roles ?? [], { sub: user.sub, username: user.username });
  }

  /**
   * `[ID.21]` — Permisos de una persona en tres capas: los del puesto, los suyos
   * propios (de más / de menos) y los efectivos.
   */
  @Get(':id/permissions')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Permisos de un usuario: los que le da su puesto, los propios (de más/de menos) y los efectivos' })
  userPermissions(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.usersService.permissions(id);
  }

  /**
   * `[ID.21]` — Fija los permisos propios del usuario (la diferencia contra su
   * puesto). PUT: la lista que llega es la final; lo que no venga vuelve al
   * estándar del puesto.
   */
  @Put(':id/permissions')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Fija los permisos propios de un usuario (allow=true concede de más, allow=false quita). Queda asentado en identity.user_events.' })
  setUserPermissions(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { overrides?: Array<{ permission_key: string; allow: boolean; nota?: string | null }> },
    @ReqUser() user: AuthUser,
  ) {
    return this.usersService.setPermissions(id, body?.overrides ?? [], {
      sub: user.sub,
      username: user.username,
    });
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
