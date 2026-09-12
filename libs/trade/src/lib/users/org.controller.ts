import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  ReqUser,
  RequireAuthGuard,
  RequirePermissions,
  RolesGuard,
} from '@megadulces/platform-core';
import { OrgService, type OrgRequester } from './org.service';
import {
  PositionResponsibilityDto,
  PositionWriteDto,
  ReportsToDto,
  UserResponsibilityDto,
} from './dto/org-write.dto';

/**
 * `[AU.0]` — La organización por API.
 *
 * ── Por qué `/org` y no `/users/...` ────────────────────────────────────────
 * Lo de la persona (`/org/users/:id/...`) podría colgar del prefijo `users`,
 * que ya tiene la familia `:id/roles`, `:id/permissions`, `:id/scope`,
 * `:id/events`. **Se eligió NO hacerlo**: serían dos controllers sobre el mismo
 * prefijo, y `UsersController` ya declara un `@Get(':id')` comodín. Hoy no
 * chocan —los sub-recursos tienen un segmento más— pero la tabla de rutas queda
 * repartida en dos archivos y el día que alguien agregue otro `:id/algo` la
 * ambigüedad no se ve hasta runtime. Un prefijo, un archivo, un orden legible.
 *
 * ── El reparto de permisos ──────────────────────────────────────────────────
 * Leer exige `USUARIOS_VER`; escribir exige `USUARIOS_GESTIONAR`. Es el mismo
 * par que ya gobierna el padrón, y a propósito: quien administra a la persona
 * administra la estructura en la que encaja. No se inventa un permiso nuevo —
 * `[LC.6.2]` dejó la lección de que un módulo no está entregado hasta que su
 * permiso está REPARTIDO en prod, y un par sin repartir no abre nada.
 */
@ApiTags('org')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  // ── Catálogo de responsabilidades ────────────────────────────────────────
  // Va ANTES que `positions/:code` por legibilidad, no por necesidad: son
  // prefijos estáticos distintos y no se solapan.

  @Get('responsibilities')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Catálogo de responsabilidades, con cuántos responden de cada una' })
  listResponsibilities() {
    return this.org.listResponsibilities();
  }

  @Get('coherencia')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Los desacuerdos entre puesto, rol/permiso y alcance' })
  coherencia() {
    return this.org.coherencia();
  }

  // ── Puestos ──────────────────────────────────────────────────────────────

  @Get('positions')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Catálogo de puestos con ocupantes, jefe y responsabilidades' })
  listPositions() {
    return this.org.listPositions();
  }

  @Get('positions/:code')
  @RequirePermissions(Permission.USUARIOS_VER)
  getPosition(@Param('code') code: string) {
    return this.org.getPosition(code);
  }

  @Post('positions')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  createPosition(@Body() dto: PositionWriteDto, @ReqUser() user: OrgRequester) {
    return this.org.createPosition(dto, user);
  }

  @Put('positions/:code')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  updatePosition(
    @Param('code') code: string,
    @Body() dto: PositionWriteDto,
    @ReqUser() user: OrgRequester,
  ) {
    return this.org.updatePosition(code, dto, user);
  }

  @Delete('positions/:code')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'Baja del puesto. Se niega si lo ocupa alguien o si es jefe de otro' })
  deletePosition(@Param('code') code: string, @ReqUser() user: OrgRequester) {
    return this.org.deletePosition(code, user);
  }

  /**
   * La arista de mando. El ciclo lo rechaza el trigger de la base y acá vuelve
   * como 400 con el nombre de los dos puestos.
   */
  @Put('positions/:code/reports-to')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  setReportsTo(
    @Param('code') code: string,
    @Body() dto: ReportsToDto,
    @ReqUser() user: OrgRequester,
  ) {
    return this.org.setReportsTo(code, dto.reports_to_position_code ?? null, user);
  }

  // ── De qué responde un puesto ────────────────────────────────────────────

  @Get('positions/:code/responsibilities')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Con el diagnóstico `abre`: si el perfil del puesto puede abrirlo' })
  positionResponsibilities(@Param('code') code: string) {
    return this.org.positionResponsibilities(code);
  }

  @Post('positions/:code/responsibilities')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  addPositionResponsibility(
    @Param('code') code: string,
    @Body() dto: PositionResponsibilityDto,
    @ReqUser() user: OrgRequester,
  ) {
    return this.org.addPositionResponsibility(
      code,
      dto.responsibility_key,
      dto.es_principal ?? false,
      user,
    );
  }

  @Delete('positions/:code/responsibilities/:key')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  removePositionResponsibility(
    @Param('code') code: string,
    @Param('key') key: string,
    @ReqUser() user: OrgRequester,
  ) {
    return this.org.removePositionResponsibility(code, key, user);
  }

  // ── De qué responde una persona ──────────────────────────────────────────

  @Get('users/:id/responsibilities')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Heredadas del puesto y propias, separadas, más el efectivo' })
  userResponsibilities(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.org.userResponsibilities(id);
  }

  @Post('users/:id/responsibilities')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  @ApiOperation({ summary: 'La excepción por persona. `nota` obligatoria' })
  addUserResponsibility(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UserResponsibilityDto,
    @ReqUser() user: OrgRequester,
  ) {
    return this.org.addUserResponsibility(id, dto, user);
  }

  @Delete('users/:id/responsibilities/:rowId')
  @RequirePermissions(Permission.USUARIOS_GESTIONAR)
  removeUserResponsibility(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('rowId', new ParseUUIDPipe()) rowId: string,
    @ReqUser() user: OrgRequester,
  ) {
    return this.org.removeUserResponsibility(id, rowId, user);
  }

  @Get('users/:id/position-history')
  @RequirePermissions(Permission.USUARIOS_VER)
  @ApiOperation({ summary: 'Los tramos de `v_position_history`, con de dónde salió cada fecha' })
  positionHistory(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.org.positionHistory(id);
  }
}
