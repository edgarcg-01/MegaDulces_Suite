import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { CommercialCommissionsService } from './commercial-commissions.service';
import { CommissionRecalcService, type RecalcResultado } from './commission-recalc.service';
import { CommissionContrastService, type FaltoResumen, type FaltoFila } from './commission-contrast.service';

/**
 * RD.6 — Comisiones de Ruta Directa.
 *
 * VER y GESTIONAR son permisos propios, no colgados de `COMMERCIAL_ROUTE_SALES_VER`: ver
 * cuánto vendió una ruta y ver cuánto cobra su chofer son cosas distintas, y lo segundo es
 * nómina. Se reparten en la migración `20260908120200`, porque un permiso declarado en el
 * enum y no repartido deja el módulo inaccesible para todos salvo `ALL_PERMS` — pasó con
 * `FISCAL_PURCHASE_BOOK_*` en LC.6.2.
 */
@ApiTags('commercial-commissions')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/commissions')
export class CommercialCommissionsController {
  constructor(
    private readonly service: CommercialCommissionsService,
    private readonly recalc: CommissionRecalcService,
    private readonly contraste: CommissionContrastService,
  ) {}

  @Get('contrast')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Libro vs motor, por ruta-periodo — lee TABLA, no calcula',
    description:
      'RD.52. Query: `anio`. Cruza el espejo del libro (`commission_run_lines` de la corrida '
      + 'viva) contra la corrida del motor guardada (`commission_engine_lines`), con veredicto y '
      + 'causa. Medido el 2026-10-08 sobre 238 ruta-periodo: **111 cuadran al peso**, 46 difieren '
      + 'menos de 5%, 22 más, y **14 el motor las tira a CERO** ($35,294) — 9 por el acantilado '
      + 'del tramo y 5 sin fuente. El veredicto vive en la vista, en un solo lugar.',
  })
  contrast(@Query('anio') anio?: string) {
    return this.contraste.leer(anio ? Number(anio) : new Date().getFullYear());
  }

  @Get('headroom')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Lo que faltó — cuánto le faltó a cada ruta para el siguiente escalón o bono',
    description:
      'RD.56. Query: `anio`. **La pregunta que el Excel no puede contestar.** El tabulador es '
      + 'ESCALONADO: quedarse corto por poco no paga "un poco menos", paga el escalón de abajo o '
      + 'CERO. Medido sobre las 238 ruta-periodo del espejo: Q13 ruta 28 vendió $189,643.22, le '
      + 'faltaron **$356.77** y cobró **$0** en vez de $4,827.96; 6 no cobraron nada estando a '
      + 'menos de $10,000 del piso ($30,264) y 29 quedaron a menos de $5,000 del siguiente escalón '
      + '($18,620). ⭐ Y 141 de 238 ya están en el TOPE: decir dónde NO hay nada que perseguir '
      + 'evita mandar a un supervisor a una ruta sin margen. Lee vista: 16 ms.',
  })
  headroom(@Query('anio') anio?: string): Promise<{ resumen: FaltoResumen[]; filas: FaltoFila[] }> {
    return this.contraste.loQueFalto(anio ? Number(anio) : new Date().getFullYear());
  }

  @Post('contrast/run')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Corre el MOTOR sobre las quincenas con espejo y guarda su resultado',
    description:
      'RD.52. Body: `{ anio }` o `{ period_id }`. Llama a `computeRun` en modo **vista previa**: '
      + 'no deja corrida, no toca el espejo y no entra al libro mayor de la nómina. ⚠️ Cuesta '
      + '~12 s por quincena (lee tres fuentes de venta día por día), así que se dispara a mano y '
      + 'la pantalla lee la tabla que deja.',
  })
  contrastRun(@Body() body: { anio?: number; period_id?: string }) {
    if (body?.period_id) return this.contraste.contrastarPeriodo(body.period_id);
    return this.contraste.contrastarAnio(body?.anio ?? new Date().getFullYear());
  }

  @Get('board')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'El tablero del año — lo unico que la pantalla pide al abrir',
    description:
      'RD.22. Query: `anio` (default el actual). UNA consulta sobre tablas y **cero calculo**: 27 '
      + 'quincenas con su corrida congelada, totales, compuertas y frescura. Medido contra prod: '
      + '**2.2 ms**, contra los 6,491 ms que cuesta calcular una quincena. Cada periodo trae '
      + '`estado_calculo` = calculada | sin_calcular | en_curso | futura, y la respuesta trae '
      + '`sin_calcular[]`: las quincenas que ya cerraron y todavia no tienen numero.',
  })
  board(@Query('anio') anio?: string) {
    return this.service.board(anio ? Number(anio) : new Date().getFullYear());
  }

  @Get('universe')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'El universo DERIVADO de rutas, con el veredicto de cada una',
    description:
      'RD.17. Junta el resolvedor `mv_rd_route_identity` (11 camiones, por PK y FK), la config de '
      + 'nomina y lo que de verdad vende. Cada route_code sale con su veredicto: comisiona | '
      + 'config_inactiva | fuera_no_es_camion | camion_sin_config | camion_sin_identidad | '
      + 'tipo_sin_declarar. Antes el motor iteraba la config y 9 rutas que venden ($9.37M en 2026) '
      + 'se caian sin linea y sin aviso.',
  })
  universe() {
    return this.service.listUniverse();
  }

  @Post('recalculate-from')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Calcula una quincena y todas las cerradas que le siguen — el unico camino que escribe',
    description:
      'RD.22. Body: `{ period_id }`. Es el mismo acto las dos veces que hace falta: producir el '
      + 'numero de una quincena recien cerrada, y reconvertir desde el periodo en que aplica una '
      + 'escala nueva. **No toca lo pagado** (lo salta con su motivo y sigue: es un deposito que '
      + 'ocurrio, y la diferencia va como ajuste en la siguiente) ni lo aprobado (hay que anularlo '
      + 'a mano primero, para que el acto quede registrado). No aprueba ni paga: ADR-016.',
  })
  recalculateFrom(@Body() body: { period_id: string }): Promise<RecalcResultado> {
    return this.recalc.recalcularDesde(body?.period_id);
  }

  @Get('periods')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Quincenas del año, cada una con su corrida viva si la tiene',
    description: 'Query: `anio` (opcional, default todas). Cada periodo trae `run` = { run_id, status, total_a_pagar, rutas_sin_dato } o null.',
  })
  periods(@Query('anio') anio?: string) {
    return this.service.listPeriods(anio ? Number(anio) : undefined);
  }

  @Get('scale')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'La escala vigente a una fecha',
    description: 'Query: `on` (YYYY-MM-DD, default hoy). El tabulador vive en la DB: cambiarlo es un INSERT con valid_from, no un deploy.',
  })
  scale(@Query('on') on?: string) {
    return this.service.getScale(on || new Date().toISOString().slice(0, 10));
  }

  @Post('preview')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Calcula el periodo SIN persistir, para cuadrarlo antes de crear la corrida',
    description: 'Body: `{ period_id }`. Devuelve el mismo payload que /compute pero con `run_id: null`.',
  })
  preview(@Body() body: { period_id: string }) {
    return this.service.computeRun(body?.period_id, { dryRun: true });
  }

  @Post('compute')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Crea la corrida de UN periodo cerrado, en estado borrador',
    description:
      'Body: `{ period_id, replace? }`. Un periodo tiene UNA corrida viva; `replace` sólo funciona '
      + 'si está en `borrador` o `bloqueada`. **Rechaza un periodo que todavía corre** (una corrida '
      + 'es un valor congelado: para mirar cómo va está `/preview`) y **rechaza lo pagado y lo '
      + 'aprobado**. Para el caso normal usa `/recalculate-from`, que hace éste y los siguientes.',
  })
  compute(@Body() body: { period_id: string; replace?: boolean }) {
    return this.service.computeRun(body?.period_id, { replace: body?.replace === true });
  }

  @Get('runs/:id')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({ summary: 'La corrida con su detalle por ruta y beneficiario' })
  run(@Param('id') id: string) {
    return this.service.getRun(id);
  }

  @Post('runs/:id/approve')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({ summary: 'borrador → aprobado. El motor calcula; aprobar es humano (ADR-016)' })
  approve(@Param('id') id: string) {
    return this.service.setStatus(id, 'aprobado');
  }

  @Post('runs/:id/pay')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({ summary: 'aprobado → pagado. No se salta el paso de aprobación' })
  pay(@Param('id') id: string) {
    return this.service.setStatus(id, 'pagado');
  }

  @Post('runs/:id/void')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({ summary: 'Anula la corrida. Una pagada no se anula: queda como está' })
  voidRun(@Param('id') id: string) {
    return this.service.setStatus(id, 'anulado');
  }
}
