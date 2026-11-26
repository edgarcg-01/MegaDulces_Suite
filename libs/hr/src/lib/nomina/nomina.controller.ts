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
 * ⛔⛔ **DOS claves, no una — partidas el 2026-11-25 (`[NE.2.6]` / D12), y la razón se midió:**
 * con una sola clave para los cinco verbos, el frente quedó desplegado en prod **sin poder
 * producir una fila** (las tres tablas en 0), porque la clave espera a una pantalla que a su vez
 * espera a que esta API esté probada. Un círculo. Se parte por **naturaleza del verbo**, que es
 * lo que ADR-054 pide (el permiso es una CLAVE, no una tupla):
 *
 * - `HR_NOMINA_CALENDARIO` — sólo `periodos/sincronizar`. **No toca personas**: deriva el
 *   calendario de semanas de ContPAQi, es idempotente y reporta lo que no encaja. No muestra
 *   nombres, no escribe identidad, no pide firma → **no necesita pantalla para repartirse**.
 * - `HR_NOMINA_GESTIONAR` — el puente y la cola. **Sí** escriben identidad (por empate de NOMBRE)
 *   y la cola además muestra nombres y exige firma. Ésas **siguen sin repartirse** hasta que
 *   exista la pantalla de `[NE.2.5]` (`SIN_REPARTIR` del candado de reparto): un alias equivocado
 *   liga a una persona con el sueldo de otra.
 *
 * ⚠️ Hoy **ninguna de las dos está repartida**: partir la clave es decisión técnica, repartirla es
 * de quien manda en los accesos (D12, pendiente). Esto deja la puerta construida, no abierta.
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

  // ⭐ El único verbo del módulo que NO toca personas: por eso lleva su propia clave y puede
  //    repartirse sin pantalla. Ver el encabezado del archivo y D12.
  @Post('periodos/sincronizar')
  @RequirePermissions(Permission.HR_NOMINA_CALENDARIO)
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
