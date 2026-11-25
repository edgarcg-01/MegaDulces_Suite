import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  HrColaNominaDto, HrPeriodosDto, HrPuenteNominaDto, HrPuenteRegistroDto, HrResolucionDto, HrResuelveCasoDto,
} from '@megadulces/contracts';
import { HrNominaColaService } from './nomina-cola.service';
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
    private readonly colaSrv: HrNominaColaService,
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

  // ── `[NE.2.5]` La cola de los que no ligaron ──────────────────────────────────────────────
  // ⚠️ Estas dos rutas SÍ devuelven nombres de personas, al revés que las de arriba: una
  //    identidad no se resuelve a ciegas. Por eso la clave sigue sin repartir.

  @Get('cola')
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — lo que falta por ligar a mano, con el nombre de nómina, cuándo cobró y los candidatos que el puente miró y descartó. No escribe nada.',
  })
  cola(@Query('dias') dias?: string): Promise<HrColaNominaDto> {
    return this.colaSrv.cola(dias === undefined || dias === '' ? undefined : Number(dias));
  }

  @Post('cola/resolver')
  @RequirePermissions(Permission.HR_NOMINA_GESTIONAR)
  @ApiOperation({
    summary: 'RH · nómina — ligar un código a una persona a mano y FIRMADO (matched_by = manual). Idempotente; para corregir uno ya ligado hay que declarar a quién apunta hoy.',
  })
  resuelve(@Body() b: HrResuelveCasoDto): Promise<HrResolucionDto> {
    return this.colaSrv.resuelve(b);
  }
}
