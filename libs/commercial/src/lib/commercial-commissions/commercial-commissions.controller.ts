import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  RolesGuard, RequirePermissions, RequireAnyPermission, Permission, isPlatformAdminRole,
} from '@megadulces/platform-core';
import { CommercialCommissionsService, type SimulacionEscala } from './commercial-commissions.service';
import { CommissionRecalcService, type RecalcResultado } from './commission-recalc.service';
import { CommissionContrastService, type FaltoResumen, type FaltoFila } from './commission-contrast.service';
import {
  CommissionPadronService, type PadronFila, type AltaRuta, type EditarRuta, type AvisoPagadas,
} from './commission-padron.service';
import {
  CommissionBonosService, type BonoFila, type AltaBono, type EditarBono,
} from './commission-bonos.service';
import { CommissionAutoRunService, type RevisionAuto } from './commission-auto-run.service';
import {
  CommissionBeneficiariosService, type SupervisorNomina, type FijarNomina,
} from './commission-beneficiarios.service';
import {
  CommissionObjectiveService, type ObjetivoConfig, type ObjetivoResultado,
  type Criterio, type EditarCriterio, type MarcarDto, type ObjetivoMarca,
} from './commission-objective.service';

/** Lo que `RolesGuard` deja en `request.user`: el mapa y los roles FRESCOS de DB, no los del token. */
interface ActorComisiones {
  permissions?: Record<string, boolean>;
  roles_frescos?: string[];
}

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
    private readonly objetivo: CommissionObjectiveService,
    private readonly padronSvc: CommissionPadronService,
    private readonly bonosSvc: CommissionBonosService,
    private readonly autoRunSvc: CommissionAutoRunService,
    private readonly beneficiariosSvc: CommissionBeneficiariosService,
  ) {}

  /**
   * `[RD.59]` La configuración del bono por objetivo: los criterios, sus pesos y su estado.
   * ⛔ Leer la configuracion es VER; cambiarla es GESTIONAR. No se mezclan: ver cuanto cobra una
   * ruta y poder mover el umbral que decide ese cobro no son la misma facultad.
   */
  @Get('objective')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  objetivoConfig(): Promise<ObjetivoConfig> {
    return this.objetivo.configuracion();
  }

  /** [RD.59] El resultado del mes por ruta: lo medido, lo marcado y lo que nadie resolvio. */
  @Get('objective/result')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  objetivoResultado(@Query('anio') anio?: string, @Query('mes') mes?: string): Promise<ObjetivoResultado> {
    const hoy = new Date();
    return this.objetivo.resultado(
      anio ? Number(anio) : hoy.getFullYear(),
      mes ? Number(mes) : hoy.getMonth() + 1,
    );
  }

  /** [RD.59] Cambiar umbral, importe, peso, comparador o encender/apagar un criterio. */
  @Patch('objective/criteria/:id')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  objetivoEditar(@Param('id') id: string, @Body() cambios: EditarCriterio): Promise<Criterio> {
    return this.objetivo.editarCriterio(id, cambios);
  }

  /** [RD.59] La marca humana del criterio que nadie puede derivar. Exige motivo. */
  @Post('objective/marks')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  objetivoMarcar(@Body() dto: MarcarDto): Promise<ObjetivoMarca> {
    return this.objetivo.marcar(dto);
  }

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


  /**
   * `[RD.66]` Todas las versiones del tabulador, con sus escalones y el piso editable.
   * Lectura: la ve quien ve comisiones, porque explica CON QUÉ se calculó lo que está mirando.
   */
  @Get('scales')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Las versiones del tabulador, con sus escalones y desde cuándo rige cada una',
    description: 'Incluye `piso_editable`: la última fecha ya pagada o aprobada. Una escala nueva '
      + 'tiene que empezar DESPUÉS de esa fecha, porque lo pagado no se recalcula.',
  })
  scales() {
    return this.service.listScales();
  }

  /**
   * `[RD.66]` Estrena una versión. ⛔ GESTIONAR, no VER: esto cambia cuánto cobra cada chofer.
   */
  @Post('scales')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Crea una VERSIÓN NUEVA del tabulador; nunca pisa la vigente',
    description: 'Body: `{ valid_from, tiers[], nombre?, share_supervisor_pct? }`. Cierra la '
      + 'anterior con `valid_to = valid_from`. **Rechaza** una fecha que alcance a un periodo ya '
      + 'pagado o aprobado, escalones con hueco o traslape, y un último escalón con techo.',
  })
  createScale(
    @Body() body: {
      valid_from: string; nombre?: string; share_supervisor_pct?: number;
      tiers: { min_amount: number; max_amount: number | null; pct: number }[];
    },
  ) {
    return this.service.createScaleVersion(body);
  }

  /**
   * `[RD.86]` Qué pasaría con este tabulador, **antes** de guardarlo.
   *
   * ⛔ Es `VER` y no `GESTIONAR` a propósito: **no escribe nada**. Quien puede mirar la nómina
   * puede preguntarse qué pasaría si el escalón se moviera; estrenar la versión es otro acto.
   */
  @Post('scales/simulate')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({
    summary: 'Simula un tabulador sobre la ultima quincena PAGADA -- no escribe nada',
    description:
      'RD.86. Body: `{ tiers[] }`. El tabulador es un ACANTILADO: debajo del primer escalon la '
      + 'comision es CERO, no "un poco menos" -- hoy el piso esta en $189,999.99 y 9 ruta-periodo '
      + 'caen del lado malo por $26,932.74. Reaplica los escalones propuestos sobre las lineas ya '
      + 'medidas y congeladas de la ultima corrida pagada: NO vuelve a correr el motor (costaria '
      + '~5.7 s, leeria la fuente de hoy y mezclaria dos cambios en un solo numero) y NO recalcula '
      + 'bonos ni deducciones, para que el delta conteste solo "que hace ESTE escalon". Devuelve '
      + '`caen` y `suben`: las dos caras del acantilado, con nombre propio.',
  })
  simulateScale(
    @Body() body: { tiers: { min_amount: number; max_amount: number | null; pct: number }[] },
  ): Promise<SimulacionEscala> {
    return this.service.simularEscala(body?.tiers);
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

  /**
   * `[RD.84]` El padrón EDITABLE. ⛔ No es `/universe`: aquél es el universo derivado del ERP y
   * es de sólo lectura. Éste devuelve las filas que se pueden cambiar, cada una con lo que ya
   * produjo (quincenas pagadas y monto), para que una baja no se decida a ciegas.
   */
  @Get('routes')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({ summary: 'El padron editable de rutas que comisionan' })
  padron(): Promise<PadronFila[]> {
    return this.padronSvc.listar();
  }

  @Post('routes')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Da de alta una ruta en el padron',
    description:
      'RD.84. Body: `{ route_code, nomina_banco, activo_desde, zona?, chofer_nombre?, '
      + 'supervisor_nombre?, notes?, scale_id? }`. `activo_desde` es OBLIGATORIA: sin ella la '
      + 'ruta comisionaria tambien las quincenas anteriores a su alta. `scale_id` se resuelve '
      + 'solo con el tabulador vigente a esa fecha. Un codigo repetido NO crea una segunda fila: '
      + 'devuelve 409 y manda a reactivar la que ya existe, para que conserve su historia.',
  })
  altaRuta(@Body() body: AltaRuta): Promise<PadronFila> {
    return this.padronSvc.crear(body);
  }

  @Patch('routes/:id')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Edita una ruta del padron — la baja es un caso de esto',
    description:
      'RD.84. Dar de baja es `{ activo: false, activo_hasta, notes }`, y las TRES son '
      + 'obligatorias juntas: sin fecha la ruta deja de comisionar tambien las quincenas que si '
      + 'trabajo (ver [RD.84.0], costaba $19,096.84 en las rutas 321/322), y sin motivo nadie '
      + 'va a poder explicar la fila dentro de seis meses. Si la vigencia toca una quincena YA '
      + 'PAGADA devuelve 409 nombrando cuales y por cuanto: se repite con `confirmar: true` '
      + 'cuando esa correccion es justamente la intencion.',
  })
  editarRuta(@Param('id') id: string, @Body() body: EditarRuta): Promise<{ fila: PadronFila; aviso: AvisoPagadas | null }> {
    return this.padronSvc.editar(id, body);
  }

  /**
   * `[RD.100]` La nómina de banco de cada supervisor del padrón, vigente hoy, con su historia.
   * `nomina_banco: null` = sin configurar: el motor declara su neto como no calculable.
   */
  @Get('supervisors')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({ summary: 'La nómina de banco vigente de cada supervisor del padrón' })
  supervisores(): Promise<SupervisorNomina[]> {
    return this.beneficiariosSvc.listar();
  }

  @Post('supervisors')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Fija la nómina de banco de un supervisor a partir de una fecha (versión nueva)',
    description:
      'RD.100. Body: `{ nombre, nomina_banco, valid_from, notes? }`. Cierra la versión vigente y '
      + 'abre otra; con la misma fecha corrige la vigente. El nombre tiene que ser el supervisor '
      + 'exacto del padrón. Una fecha anterior a la versión vigente se rechaza (409).',
  })
  fijarNominaSupervisor(@Body() body: FijarNomina): Promise<SupervisorNomina[]> {
    return this.beneficiariosSvc.fijar(body);
  }

  /**
   * `[RD.85]` Los bonos quincenales de la escala VIGENTE, con lo que de verdad pagaron al lado.
   * ⛔ Los criterios del objetivo mensual no se administran acá: ver `/objective`.
   */
  @Get('bonuses')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_VER)
  @ApiOperation({ summary: 'Los bonos de la escala vigente' })
  bonos(): Promise<BonoFila[]> {
    return this.bonosSvc.listar();
  }

  @Post('bonuses')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Crea un bono quincenal — el primer INSERT que esta tabla tiene',
    description:
      'RD.85. Hasta hoy `commission_bonuses` tenia UPDATE y ningun INSERT: los 17 bonos vivos se '
      + 'sembraron por migracion, y crear uno exigia un despliegue. El libro pago $140,800 en '
      + 'bonos en 20 quincenas ($7,040 por quincena). `periodo` es OBLIGATORIO y sin valor por '
      + 'defecto: sin el, un bono mensual entra a las dos quincenas del mes y se paga DOS VECES '
      + '(RD.59). La escala se resuelve sola con la vigente.',
  })
  altaBono(@Body() body: AltaBono): Promise<BonoFila> {
    return this.bonosSvc.crear(body);
  }

  @Patch('bonuses/:id')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Edita o APAGA un bono quincenal',
    description:
      'RD.85. Un bono se apaga (`activo:false`), no se borra: apagado conserva su configuracion '
      + 'y deja explicable la quincena que si lo pago. Un criterio del objetivo mensual se '
      + 'rechaza con su mensaje — esos viven en /objective, donde la regla de que los pesos '
      + 'sumen 100% ya esta escrita, y escribirla dos veces es como las dos se desincronizan.',
  })
  editarBono(@Param('id') id: string, @Body() body: EditarBono): Promise<BonoFila> {
    return this.bonosSvc.editar(id, body);
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

  /**
   * `[RD.87]` Dispara **a mano** la misma revisión que corre a las 07:30 MX.
   *
   * ⭐ Existe para poder **ejercerla** sin esperar al día siguiente, que es la única forma de
   * verificar un automatismo antes de confiarle una quincena.
   */
  @Post('auto-run')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR)
  @ApiOperation({
    summary: 'Revisa las quincenas cerradas sin corrida y calcula las que tienen fuente completa',
    description:
      'RD.87. Deja BORRADOR: no aprueba ni paga (ADR-016). Si alguna ruta vigente no tiene '
      + 'fuente viva NO calcula y la nombra -- calcular sin dias completos no da "un numero '
      + 'aproximado", da $0, porque el tabulador es un acantilado.',
  })
  autoRun(): Promise<RevisionAuto> {
    return this.autoRunSvc.revisar('manual');
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

  /**
   * `[RD.101]` (D6) — tres llaves, tres personas: GESTIONAR calcula, APROBAR aprueba, PAGAR
   * marca pagada. Antes las tres colgaban de GESTIONAR y el que calculaba podía aprobarse y
   * pagarse solo, lo que dejaba los cuatro pasos de la corrida en decorado.
   */
  @Post('runs/:id/approve')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_APROBAR)
  @ApiOperation({ summary: 'borrador → aprobado. El motor calcula; aprobar es humano (ADR-016) y no lo hace quien calculó' })
  approve(@Param('id') id: string) {
    return this.service.setStatus(id, 'aprobado');
  }

  @Post('runs/:id/pay')
  @RequirePermissions(Permission.COMMERCIAL_COMMISSIONS_PAGAR)
  @ApiOperation({ summary: 'aprobado → pagado. No se salta el paso de aprobación' })
  pay(@Param('id') id: string) {
    return this.service.setStatus(id, 'pagado');
  }

  @Post('runs/:id/void')
  @RequireAnyPermission(Permission.COMMERCIAL_COMMISSIONS_GESTIONAR, Permission.COMMERCIAL_COMMISSIONS_APROBAR)
  @ApiOperation({ summary: 'Anula la corrida. Un borrador lo anula quien calcula; una aprobada, quien aprueba. Una pagada no se anula' })
  voidRun(@Param('id') id: string, @Req() req: { user?: ActorComisiones }) {
    const actor = req?.user;
    const esAdmin = (actor?.roles_frescos ?? []).some((r) => isPlatformAdminRole(r));
    const puedeDesaprobar = esAdmin || actor?.permissions?.[Permission.COMMERCIAL_COMMISSIONS_APROBAR] === true;
    return this.service.setStatus(id, 'anulado', { puedeDesaprobar });
  }
}
