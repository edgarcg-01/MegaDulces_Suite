import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { HrPuenteNominaDto, HrPuenteRegistroDto } from '@megadulces/contracts';
import { HrNominaPuenteService } from './nomina-puente.service';

/**
 * Fase RH · frente NE · `[NE.2.3]` — el puente entre el padrón de nómina y el de la Suite.
 *
 * Dos verbos y una sola clave, `HR_NOMINA_GESTIONAR`: consultar el empate y registrarlo son el
 * mismo acto de nómina, y la superficie es chica. ⚠️ La clave **todavía no se reparte**: gatea la
 * API y se entrega con la pantalla de `[NE.2.5]`, igual que hicieron las claves de asistencia hasta
 * que existieron sus pantallas (`SIN_REPARTIR` del candado de reparto).
 *
 * ⛔ Ninguna de las dos respuestas lleva nombres de personas: códigos, identificadores y conteos.
 */
@ApiTags('hr')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('hr/nomina/puente')
export class HrNominaController {
  constructor(private readonly puente: HrNominaPuenteService) {}

  @Get()
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — calcular el puente contra ContPAQi SIN escribir: cuántos ligan, por qué no ligan los demás, y qué códigos ya apuntan a otra persona.',
  })
  calcula(@Query('dias') dias?: string): Promise<HrPuenteNominaDto> {
    return this.puente.calcula(dias === undefined || dias === '' ? undefined : Number(dias));
  }

  @Post('registrar')
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — registrar en hr.person_aliases los que ligan. Idempotente, y NO pisa un alias que apunta a otra persona: lo reporta como conflicto.',
  })
  registra(@Body() b?: { dias?: number }): Promise<HrPuenteRegistroDto> {
    return this.puente.registra(b?.dias);
  }
}
