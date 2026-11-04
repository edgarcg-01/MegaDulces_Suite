import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ActualizarDefinicion, ContestarDefinicion, DefinicionVista, PersonaAsignable,
} from '@megadulces/contracts';
import { RolesGuard } from '../guards/roles.guard';
import { RequirePermissions } from '../decorators/permissions.decorator';
import { Permission } from '../constants/permissions';
import { BusinessDefinitionsService } from './business-definitions.service';

/**
 * `[DP.2.1]` `[DP.2.2]` — Definiciones de negocio: la regla que falta se PREGUNTA en el sistema.
 *
 * Tres llaves, tres facultades:
 *  · `DEFINICIONES_CONTESTAR` — la bandeja propia y contestar. Se reparte a todo rol con personas
 *    (como `SERVICIO_REPORTAR`), y ADEMÁS el servicio exige que quien contesta sea el DUEÑO de la
 *    pregunta (`assigned_to`): la llave abre la puerta, la fila decide si es tuya.
 *  · `DEFINICIONES_VER` — todas las preguntas con su respuesta vigente.
 *  · `DEFINICIONES_GESTIONAR` — repartir dueño y plazo, descartar.
 */
@ApiTags('definitions')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('definitions')
export class BusinessDefinitionsController {
  constructor(private readonly service: BusinessDefinitionsService) {}

  @Get()
  @RequirePermissions(Permission.DEFINICIONES_VER)
  @ApiOperation({ summary: 'Las preguntas de negocio (de un consumidor, con ?consumer=), con la respuesta que rige hoy o «sin definir»' })
  listar(@Query('consumer') consumer?: string): Promise<DefinicionVista[]> {
    return this.service.listar(consumer || undefined);
  }

  @Get('mine')
  @RequirePermissions(Permission.DEFINICIONES_CONTESTAR)
  @ApiOperation({ summary: 'Las preguntas a mi nombre: las que me toca contestar' })
  mias(): Promise<DefinicionVista[]> {
    return this.service.mias();
  }

  @Get('assignable')
  @RequirePermissions(Permission.DEFINICIONES_GESTIONAR)
  @ApiOperation({ summary: 'A quién se le puede asignar una pregunta: personas internas activas' })
  asignables(): Promise<PersonaAsignable[]> {
    return this.service.asignables();
  }

  @Post(':id/answers')
  @RequirePermissions(Permission.DEFINICIONES_CONTESTAR)
  @ApiOperation({
    summary: 'Contesta una pregunta. Sólo su dueño. No pisa: agrega una vigencia',
    description: 'Body: `{ value, valid_from (AAAA-MM-DD), note }`. El valor se valida contra el tipo de la pregunta.',
  })
  contestar(@Param('id') id: string, @Body() body: ContestarDefinicion): Promise<DefinicionVista> {
    return this.service.contestar(id, body);
  }

  @Patch(':id')
  @RequirePermissions(Permission.DEFINICIONES_GESTIONAR)
  @ApiOperation({
    summary: 'Asigna dueño o plazo, o descarta con motivo',
    description: 'Body: `{ assigned_to?: uuid|null, due_at?: ISO|null, discard_reason?: string }`. Sólo se descarta una pendiente.',
  })
  actualizar(@Param('id') id: string, @Body() body: ActualizarDefinicion): Promise<DefinicionVista> {
    return this.service.actualizar(id, body);
  }
}
