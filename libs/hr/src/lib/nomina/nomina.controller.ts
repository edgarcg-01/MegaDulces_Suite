import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { HrPeriodosDto, HrPuenteNominaDto, HrPuenteRegistroDto } from '@megadulces/contracts';
import { HrNominaPeriodosService } from './nomina-periodos.service';
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
@Controller('hr/nomina')
export class HrNominaController {
  constructor(
    private readonly puente: HrNominaPuenteService,
    private readonly periodos: HrNominaPeriodosService,
  ) {}

  @Post('periodos/sincronizar')
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — poblar hr.payroll_periods con las semanas que declara ContPAQi (sábado→viernes). Idempotente; omite y reporta lo que no cae en viernes, y lo que no puede derivar lo declara desconocido.',
  })
  sincronizaPeriodos(@Body() b?: { desde?: string }): Promise<HrPeriodosDto> {
    return this.periodos.sincroniza(b?.desde);
  }

  @Get('puente')
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — calcular el puente contra ContPAQi SIN escribir: cuántos ligan, por qué no ligan los demás, y qué códigos ya apuntan a otra persona.',
  })
  calcula(@Query('dias') dias?: string): Promise<HrPuenteNominaDto> {
    return this.puente.calcula(dias === undefined || dias === '' ? undefined : Number(dias));
  }

  @Post('puente/registrar')
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — registrar en hr.person_aliases los que ligan. Idempotente, y NO pisa un alias que apunta a otra persona: lo reporta como conflicto.',
  })
  registra(@Body() b?: { dias?: number }): Promise<HrPuenteRegistroDto> {
    return this.puente.registra(b?.dias);
  }
}
