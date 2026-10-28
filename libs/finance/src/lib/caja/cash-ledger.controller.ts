import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, isPlatformAdminRole } from '@megadulces/platform-core';
import { SUCURSAL_CAJA_GENERAL, type CorteCajaDto, type PosicionCajaDto, type CaosRetirosLibres } from '@megadulces/contracts';
import { CashLedgerService, type CreateMovementInput, type EntidadDeclarada, type CoberturaCuentasKepler } from './cash-ledger.service';
import { CajaAutofillService, type AutofillInput } from './caja-autofill.service';
import { CashCutService, type AbrirCorteInput, type CerrarCorteInput } from './cash-cut.service';
import type { PorReclasificar } from './cash-cut.service';
import type { CandadoCaja } from './caja-candado.query';
import { CajaFechaFuturaScannerService } from './caja-fecha-futura-scanner.service';
import { CajaAutollenadoService, type CorridaAutollenado, type EstadoAutollenado } from './caja-autollenado.service';

interface AuthedRequest {
  user?: {
    id?: string; sub?: string; userId?: string; username?: string;
    role_name?: string; permissions?: Record<string, boolean>;
  };
}

/**
 * CG.13/CG.17 — Caja General: el libro donde la plataforma REGISTRA el efectivo (ADR-070).
 *
 * Distinto de `CajaGeneralController` (`/finance/caja`, CG.1-CG.7), que es la lectura del
 * ESPEJO del Access y seguirá viva durante el traslape. Éste es el lado que escribe.
 *
 * Permisos PROPIOS (§CG.14): hasta ahora todo `/finanzas/caja` colgaba de `FINANCE_BANK_VER`,
 * que es de Bancos. VER consulta · GESTIONAR captura · AUTORIZAR (fuera de todo MODULE_GROUP)
 * cierra el corte y confirma el mapa de conceptos. Capturar ≠ autorizar.
 */
@ApiTags('finance-cash-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cash-ledger')
export class CashLedgerController {
  constructor(
    private readonly svc: CashLedgerService,
    private readonly autofill: CajaAutofillService,
    private readonly cortes: CashCutService,
    private readonly fechaFutura: CajaFechaFuturaScannerService,
    private readonly autollenado: CajaAutollenadoService,
  ) {}

  /** El JWT trae el id con nombres distintos según el emisor; se toma el primero que exista. */
  private user(req: AuthedRequest) {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  /**
   * ⛔ CG.19 Capa 1b — **¿este usuario puede ver el esperado?**
   *
   * Sólo quien AUTORIZA, que es la segunda llave del corte y la persona que ya no puede ser la
   * que lo cerró. Quien captura cuenta a ciegas: el esperado se revela al sellar el conteo.
   *
   * Calca `revela()` de `store-arqueo.controller.ts` (SM.8), que resuelve exactamente lo mismo.
   * Se lee del permiso, NO del rol: un gate por nombre de rol se rompe en la siguiente alta.
   */
  private revela(req: AuthedRequest): boolean {
    return isPlatformAdminRole(req?.user?.role_name)
      || req?.user?.permissions?.[Permission.FINANCE_CAJA_AUTORIZAR] === true;
  }

  /**
   * `[CG.86]` **`mios=1` — el historial de quien captura.**
   *
   * Edgar: *"que el usuario vea qué movimientos ya hizo"*. El libro ya traía la columna de quién
   * capturó y el buscador ya miraba `created_by_username`, pero **no había filtro**: la persona
   * tenía que buscarse a sí misma escribiendo su nombre, y un buscador de texto sobre un nombre
   * no es una identidad — dos «Guillermo» existen en esta base, y un apellido mal tecleado
   * devuelve el libro de otro.
   *
   * ⭐ Por eso filtra por `created_by` (el **id**), que sale del token y no de lo que se teclee.
   * No es un atajo de búsqueda: es la diferencia entre «lo que hice yo» y «lo que dice mi nombre».
   *
   * ⚠️ **No reemplaza al permiso.** Quien tiene `FINANCE_CAJA_VER` sigue viendo el libro completo
   * cuando no pide `mios`: esto es una VISTA, no un alcance. Convertirlo en alcance escondería a
   * un cajero los movimientos de otro en el mismo día, y el arqueo del día es de la caja, no de
   * la persona.
   */
  @Get()
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Libro de caja: movimientos + KPIs del MISMO filtro. from/to, tipo, sucursal, cuenta, search, mios (sólo lo que capturó quien pregunta).' })
  list(
    @Req() req: AuthedRequest,
    @Query('from') from?: string, @Query('to') to?: string, @Query('tipo') tipo?: string,
    @Query('sucursal') sucursal?: string, @Query('cuenta') cuenta?: string,
    @Query('search') search?: string, @Query('limit') limit?: string, @Query('offset') offset?: string,
    @Query('mios') mios?: string,
  ) {
    return this.svc.list({
      from, to, tipo, sucursal, cuenta, search,
      // Se resuelve ACÁ, no en el servicio: el id sale del token de ESTA petición. Si el servicio
      // lo recibiera como parámetro libre, `mios` pasaría a ser «los de cualquiera que yo diga».
      solo_de: mios === '1' || mios === 'true' ? (req?.user?.id ?? null) : null,
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('conceptos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Catálogo de conceptos de Kepler (vista derivada del ODS). El concepto es POR SUCURSAL.' })
  conceptos(@Query('sucursal') sucursal?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.conceptos({ sucursal, search, limit: limit ? Number(limit) : undefined });
  }

  @Get('cobertura')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Cobertura del catálogo de conceptos y del mapa HITL. Va SIEMPRE a la pantalla: "0 conceptos" por carril caído no puede verse igual que "no hay conceptos".' })
  cobertura() {
    return this.svc.coverage();
  }

  /**
   * CG.21 — va ANTES de `@Get(':id')` como el resto: Nest resuelve por orden de declaración y
   * `movimientos-pendientes` se comería como un id.
   */
  @Get('movimientos-pendientes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.21 — Movimientos que Kepler YA registró en una caja de efectivo (kdm1.c45 contra el catálogo kdb1) y todavía no se aplicaron al libro, LOS DOS SIGNOS. El capturista CONFIRMA en vez de teclear: el valor se toma del ERP y el registro precede al dinero. Filtros: tipo(ingreso|gasto), caja(clave de kdb1, 0011=CAJA GENERAL), sucursal, from/to, search.' })
  movimientosPendientes(
    @Query('tipo') tipo?: string,
    @Query('caja') caja?: string,
    @Query('sucursal') sucursal?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    /**
     * `[CGA11Y-O3b]` El filtro que hace clicable la tira de accesos. Sin él los conteos por
     * grupo se podían MOSTRAR pero no USAR: tocar «Egresos 117» no tenía con qué acotar la lista.
     *
     * ⚠️ `doc_tipo` y no `origen_tipo`, por lo mismo que los conteos: en esta vista `origen_tipo`
     * sale del signo y no distingue nada. `U-A-5` = depósito de efectivo · `X-D-26` = pago/egreso
     * · `D-23-1` = cobro de ruta de detalle.
     */
    @Query('doc_tipo') docTipo?: string,
  ) {
    return this.svc.movimientosPendientes({
      tipo, caja, sucursal, from, to, search,
      doc_tipo: docTipo,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // CS.3 — va ANTES de `@Get(':id')` (Nest resuelve por orden; `caos-capturables` se comería como id).
  @Get('caos-capturables')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CS.3 — Movimientos de CAOS (caja fuerte) pendientes de capturar, con sus denominaciones para autorrellenar el arqueo. Segunda fuente de la bandeja, convive con los documentos de Kepler.' })
  caosCapturables(
    @Query('tipo') tipo?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.caosCapturables({ tipo, from, to, search, limit: limit ? Number(limit) : undefined });
  }

  // `[CGA-A.60]` va ANTES de `@Get(':id')`. Los retiros que todavía pueden pagar un lote.
  @Get('caos-retiros-libres')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGA-A.60] Retiros de CAOS con dinero libre (sin custodia cerrada): los que pueden pagar un lote de egresos de la cola.' })
  caosRetirosLibres(@Query('from') from?: string, @Query('limit') limit?: string): Promise<CaosRetirosLibres> {
    return this.svc.retirosLibres({ from, limit: limit ? Number(limit) : undefined });
  }

  // CS.3.3 — va ANTES de `@Get(':id')` (Nest resuelve por orden). El detector: propone qué retiros
  // del cajero (CAOS) pudieron pagar un gasto, rankeados por patrones medidos + lo aprendido.
  @Get('caos-candidatos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CS.3.3 — Propone los retiros de CAOS que pudieron pagar un gasto (rankeados por mismo día + ref + monto + aprendido). No aplica: el humano confirma.' })
  caosCandidatos(
    @Query('fecha') fecha?: string,
    @Query('monto') monto?: string,
    @Query('beneficiario') beneficiario?: string,
    @Query('concepto') concepto?: string,
    @Query('sucursal') sucursal?: string,
    @Query('tipo') tipo?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.caosCandidatos({
      fecha, monto: monto ? Number(monto) : undefined, beneficiario, concepto, sucursal, tipo,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('cajas')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.21 — Las cajas de efectivo que Kepler declara en kdb1 (c3=EFECTIVO), con su volumen MEDIDO en la ventana. Sale del catálogo y no de los movimientos: una caja dormida tiene que poder verse, o sería indistinguible de una que no existe.' })
  cajas(@Query('dias') dias?: string) {
    return this.svc.cajas({ dias: dias ? Number(dias) : undefined });
  }

  /**
   * Ruta anterior, viva para no romper a un front desplegado que todavía la llame. Responde lo
   * mismo acotado a `tipo=ingreso`. ⚠️ `tipo_cuenta` ya no filtra nada: era el regex sobre el
   * nombre del cliente que dejaba fuera 38 de 330 cobros de caja (las rutas de Morelia). Se
   * acepta y se ignora en vez de fallar, porque fallar dejaría la bandeja vacía sin decir por qué.
   */
  @Get('ingresos-pendientes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.19 (superseded por movimientos-pendientes) — Cobros de caja pendientes de aplicar.' })
  ingresosPendientes(
    @Query('sucursal') sucursal?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.ingresosPendientes({ sucursal, from, to, search, limit: limit ? Number(limit) : undefined });
  }

  /**
   * `[CG.25]` — va ANTES de `@Get(':id')` como el resto del archivo. Dispara a mano el vigilante
   * de la fecha adelantada: mide, sigue a Kepler en lo que ya se corrigió allá, y avisa.
   *
   * Existe para poder VERIFICARLO sin esperar a las 07:15, que es la única forma de saber que un
   * cron hace lo que dice. Es idempotente: si no hay nada que seguir, no escribe nada.
   */
  @Post('fecha-futura/scan')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.25 — Corre ya el vigilante de fechas adelantadas: re-sincroniza las que Kepler ya corrigió y devuelve lo que sigue mal (libro, por capturar y congelados en un corte firmado).' })
  scanFechaFutura() {
    return this.fechaFutura.scan();
  }

  @Post('autofill')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'PROPONE los campos del movimiento con su procedencia y confianza. No guarda nada. Lo que no puede proponer sale en null con motivo.' })
  suggest(@Body() body: AutofillInput) {
    return this.autofill.suggest(body ?? {});
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  // `[CGS.8]` El resumen dice «salvo que venga sin clasificar» porque ahora es condicional: un
  // resumen que afirma una validación que ya no siempre corre es peor que no tenerlo.
  @ApiOperation({ summary: 'Registra un movimiento. Folio atómico, par cuenta/concepto validado contra el catálogo vivo —salvo que venga con `sin_clasificar_motivo`, que lo deja vacío a propósito y declarado— y arqueo que cuadra o no se guarda.' })
  create(@Body() body: CreateMovementInput, @Req() req: AuthedRequest) {
    // `[CG.154]` `createTraducido` y no `create`: las reglas de la tabla (glosa corta, monto en
    // cero, uuid mal formado) salían como **500 Internal server error** con el SQL adentro.
    return this.svc.createTraducido(body, this.user(req));
  }

  /**
   * `[CG.190]` — **Corre el autollenado. SIMULA salvo que se pida aplicar.** Va ANTES de
   * `@Get(':id')` como el resto del archivo.
   *
   * · `POST /autollenado/correr` → contesta **qué haría**: cuántos movimientos registraría, por
   *   cuánto, y qué dejaría fuera con el motivo de cada exclusión. **No escribe una sola fila.**
   * · `POST /autollenado/correr?aplicar=1` → lo hace.
   *
   * ⛔ El default es simular, y no es una cortesía: esto escribe dinero en el libro, y el camino
   * caro de equivocarse no es un 500 sino movimientos que después hay que cancelar de a uno. La
   * simulación corre el resolvedor REAL sobre la cola REAL —lo único que no hace es el `INSERT`—
   * así que su plan es el plan, no una estimación.
   *
   * ⛔ Pide `FINANCE_CAJA_GESTIONAR`, el mismo permiso que confirmar un lote, y no uno nuevo: lo
   * que hace es exactamente eso. Inventarle un permiso propio lo dejaría repartido en 0 roles el
   * día del estreno, que es como `[ETQ-AVISOS.3]` se quedó sin nadie.
   */
  @Post('autollenado/correr')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[CG.190] Autollenado: registra en el libro los documentos pendientes de Kepler, dentro del alcance, cuya cuenta el resolvedor ya resuelve sin que nadie elija. SIMULA por default (no escribe); con ?aplicar=1 escribe. Idempotente: lo ya capturado vuelve como duplicado. Devuelve qué registró/registraría y qué dejó fuera con su motivo (mal fechado en Kepler · sin resolver · fuera de alcance).' })
  correrAutollenado(@Query('aplicar') aplicar?: string): Promise<CorridaAutollenado> {
    return this.autollenado.correr({ aplicar: aplicar === '1' || aplicar === 'true' });
  }

  /**
   * `[CG.190]` — Qué dejó la última corrida. Va ANTES de `@Get(':id')` como el resto.
   *
   * ⚠️ Es el estado **de este proceso**, no el histórico: con varias réplicas de la API cada una
   * contesta por la suya, y `ultima.aplicado = false` significa que fue una simulación — sus
   * cifras son lo que haría, no lo que hizo. El histórico real vive en `analytics.cron_runs`
   * (`caja_autollenado`), que es compartido y es lo que mira el tablero de salud.
   */
  @Get('autollenado/estado')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CG.190] Estado del autollenado: piso de alcance, si el cron está prendido, y el resumen de la última corrida DE ESTE PROCESO (null = todavía no corrió acá; aplicado:false = fue simulación). El histórico está en analytics.cron_runs.' })
  estadoAutollenado(): EstadoAutollenado {
    return this.autollenado.estado();
  }

  /**
   * ⭐⭐ `[CGA-A.18]` **Declarar la cuenta/concepto de una entidad.** Va ANTES de `@Get(':id')`.
   *
   * Existe porque el 2026-10-19 hubo que abrir psql y correr un `INSERT` a mano para `CP036`:
   * la tabla `finance.caja_autofill_declarada` vivía desde el 13-oct y **ningún endpoint la
   * escribía**. Mismo defecto que `[CG.22.6]` ya había encontrado en `caja_classify_rules`.
   *
   * ⛔ `FINANCE_CAJA_AUTORIZAR` y no `GESTIONAR`: esto no captura UN movimiento, decide la cuenta
   * contable de **todos los de esa entidad, de ahora en adelante**. Es la misma llave que
   * confirma el mapa de conceptos.
   */
  @Post('autofill/declarar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[CGA-A.18] Declara el par cuenta/concepto de una entidad (lo que NO se puede derivar). Exige motivo de 10+ caracteres y valida el par contra el catálogo vivo de Kepler. Reemplaza al INSERT por psql, que era la única puerta. Idempotente por entidad: vuelve a declarar y se actualiza.' })
  declararEntidad(
    @Body() body: { entidad_code?: string; kepler_cuenta?: string; kepler_concepto?: string; motivo?: string; sucursal?: string },
    @Req() req: AuthedRequest,
  ): Promise<EntidadDeclarada> {
    return this.svc.declararEntidad(body ?? {}, this.user(req));
  }

  /** `[CGA-A.18]` Lo declarado, para revisarlo. Va ANTES de `@Get(':id')` como el resto. */
  @Get('autofill/declaradas')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGA-A.18] Las entidades cuya cuenta/concepto se declaró a mano, con su motivo y quién la declaró. Lo DERIVADO no aparece acá: esto es sólo lo que alguien decidió.' })
  declaradas(): Promise<EntidadDeclarada[]> {
    return this.svc.declaradas();
  }

  /** `[CGA-A.19]` Quitar una declaración. Misma llave que declararla: decide para toda la entidad. */
  @Delete('autofill/declaradas/:entidad_code')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[CGA-A.19] Quita la cuenta/concepto declarada de una entidad. La entidad vuelve a resolverse por la póliza o por su tipo de documento; lo ya confirmado no cambia.' })
  quitarDeclarada(@Param('entidad_code') entidad: string, @Req() req: AuthedRequest): Promise<{ quitada: boolean }> {
    return this.svc.quitarDeclarada(entidad, this.user(req));
  }

  /**
   * ⭐ `[CGA-A.19]` Cuántos movimientos de la cola tienen su cuenta de Kepler, sobre el universo
   * entero (no la página), y cuáles entidades no. Va ANTES de `@Get(':id')`.
   */
  @Get('cuentas-kepler/cobertura')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGA-A.19] Cobertura de cuentas de Kepler sobre TODO el universo de la cola: con cuenta (por fuente: póliza, tipo de documento, regla, ruta, declarada), falta concepto, y sin cuenta agrupado por entidad. Con tope declarado (truncado).' })
  coberturaCuentasKepler(@Query('caja') caja?: string, @Query('sucursal') sucursal?: string): Promise<CoberturaCuentasKepler> {
    return this.svc.coberturaCuentasKepler({ caja, sucursal });
  }

  /**
   * CG.20 — va ANTES de `@Get(':id')` como el resto; `lote` se comería como un id.
   */
  @Post('lote')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.20/CG.21 — Confirma N movimientos de un golpe, entren o salgan. Cada fila va en SU transacción: una que falla NO tumba a las demás (si el lote fuera todo-o-nada, la persona volvería a capturar de a una). Devuelve el estado por fila: guardado | duplicado | rechazado | no_confirmable, y el total suma SÓLO lo guardado. [CG.48] El lote ESPEJA al ERP: ya no acepta `monto_contado` por fila — era la única vía por la que una cifra contada entraba al libro sin desglose por denominación. Contar distinto va por POST / (captura anclada, el monto nace del desglose); contar el día va por el corte.' })
  crearLote(
    @Body() body: {
      items: Array<{ origen_ref: string; fecha?: string; sucursal?: string; client_uuid?: string }>;
      // `[CGA-A.60]` El retiro de CAOS que paga los egresos del lote; lo que no alcance, del cajón.
      caos_retiro?: { device: string; external_id: number } | null;
    },
    @Req() req: AuthedRequest,
  ) {
    return this.svc.crearLote(body ?? { items: [] }, this.user(req));
  }

  /**
   * CG.22.6 — va ANTES de `@Get(':id')` como el resto. Declara a qué cuenta va un beneficiario,
   * desde la captura. Medido: `caja_classify_rules` tenía 0 filas en prod y NO existía ninguna
   * pantalla para cargarlas — el bloqueo de «0 de 8 se confirman» no era falta de trabajo, era
   * falta de puerta.
   */
  @Post('reglas')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.22.6 — Declara que un beneficiario va SIEMPRE a un par (cuenta, concepto) de Kepler, de la mano de quien captura. El patrón se ancla y se escapa: sin anclar, un beneficiario corto clasificaría media bandeja. Valida el par contra el catálogo vivo y es idempotente: declarar dos veces lo mismo no apila reglas.' })
  declararRegla(
    @Body() body: { beneficiario?: string; kepler_cuenta?: string; kepler_concepto?: string; sucursal?: string; nota?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.svc.declararCuentaDeBeneficiario(body ?? {}, this.user(req));
  }

  /**
   * `[CG.27-B.0]` — va ANTES de `@Get(':id')` como el resto. Lo que está declarado, listado.
   * Hasta ahora las reglas sólo se podían escribir y no había forma de verlas.
   */
  @Get('reglas')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.27 — Las reglas de clasificacion declaradas, por prioridad. `incluir_inactivas=true` trae tambien las apagadas y las suprimidas.' })
  listarReglas(@Query('incluir_inactivas') incluir?: string, @Query('limit') limit?: string) {
    return this.svc.listarReglas({
      incluir_inactivas: incluir === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * `[CG.27-B.0]` Corrige o APAGA una regla. ⛔ No hay `DELETE`: una regla que ya clasificó
   * dinero se desactiva, no se borra — borrarla dejaría movimientos con una cuenta que nadie
   * puede explicar de dónde salió.
   */
  @Patch('reglas/:id')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.27 — Cambia el par contable de una regla o la desactiva. El PATRON no se edita: cambiarlo es otra regla (se apaga esta y se declara la nueva), o se reescribiria en silencio la explicacion de todo lo que ya clasifico.' })
  actualizarRegla(
    @Param('id') id: string,
    @Body() body: { kepler_cuenta?: string; kepler_concepto?: string; sucursal?: string; active?: boolean; nota?: string },
    @Req() req: AuthedRequest,
  ) {
    return this.svc.actualizarRegla(id, body ?? {}, this.user(req));
  }

  /**
   * ⭐ `[CG.27-B.1/B.3]` — va ANTES de `@Get(':id')` como el resto. Los que repiten y nadie declaró
   * su cuenta, más los que dejaron de cobrar. Es el 69 % de los clics de la caja.
   */
  @Get('recurrentes-sin-regla')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.27 — Beneficiarios que repiten (>= min_pagos en la ventana) y que NINGUNA regla viva clasifica, con su CV de importe y sus dias sin pago. El veredicto de regla lo da el MISMO matcher que la bandeja, corrido sobre los movimientos reales: una lista con otro criterio diria "falta declarar" sobre algo ya declarado.' })
  recurrentesSinRegla(
    @Query('dias') dias?: string,
    @Query('min_pagos') minPagos?: string,
    @Query('incluir_cubiertos') incluirCubiertos?: string,
  ) {
    return this.svc.recurrentesSinRegla({
      dias: dias ? Number(dias) : undefined,
      min_pagos: minPagos ? Number(minPagos) : undefined,
      incluir_cubiertos: incluirCubiertos === 'true',
    });
  }

  @Get('frecuentes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.20 — Los pares (cuenta, concepto, beneficiario) que ESE capturista más repite, para ofrecerlos de un toque. Medido: 57% de los gastos cae en un par usado 3+ veces. ⚠️ Para lo que NO tiene documento en Kepler: desde CG.21 el gasto con documento se confirma desde la bandeja. Esto baja los clics, no vuelve auditable el dato.' })
  frecuentes(
    @Query('tipo') tipo?: string,
    @Query('sucursal') sucursal?: string,
    @Query('limit') limit?: string,
    @Req() req?: AuthedRequest,
  ) {
    return this.svc.frecuentes({ tipo, sucursal, limit: limit ? Number(limit) : undefined }, this.user(req as AuthedRequest));
  }

  // ⚠️ Estas rutas van ANTES de @Get(':id'): Nest resuelve por orden de declaracion y
  // 'cortes'/'saldo' se comerian como si fueran un id. Misma trampa que en LC.2.

  @Get('saldo/:sucursal')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Saldo de la caja: fondo del corte abierto + efecto de sus movimientos. DERIVADO, no guardado. Sin corte abierto devuelve null y lo declara, no 0. CG.19: el esperado y la diferencia SOLO viajan a quien AUTORIZA — quien captura cuenta a ciegas, y lo que se oculta se declara (saldo_oculto).' })
  saldo(@Param('sucursal') sucursal: string, @Req() req: AuthedRequest) {
    return this.cortes.saldo(sucursal, this.revela(req));
  }

  /**
   * `[CG.26]` — El ARQUEO DE FIN DE JORNADA. Va ANTES de `@Get(':id')` como el resto del archivo.
   *
   * No exige corte abierto: en prod hay CERO cortes, asi que atar el cierre del dia a que alguien
   * se acuerde de abrir uno es lo mismo que no tener cierre. Si hay corte, se informa.
   */
  @Get('arqueo-dia')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.26 — Cierre de jornada: el dia en caja general y en el cajero (CAOS), con los SEIS tipos del cajero y lo que no se puede afirmar declarado. `fecha` por default = hoy en Mexico; la jornada del cajero sale de su propio `accounting_date`.' })
  arqueoDia(@Query('fecha') fecha?: string, @Query('sucursal') sucursal?: string) {
    return this.cortes.arqueoDelDia(fecha, sucursal || SUCURSAL_CAJA_GENERAL);
  }

  /**
   * `[CGP-VEC.1]` Los cierres de ruta vecinal que ya tienen arqueo conciliado y no están en el libro.
   *
   * ⛔ Va ANTES de `@Get(':id')`, como el resto del archivo: Nest resuelve por orden de declaración
   * y `vecinal-pendientes` se comería como un id.
   *
   * Es una LECTURA de una fuente que ya existe, no un importador: el árbitro es
   * `analytics.v_vecinal_conciliacion` y acá sólo se descuenta lo que el libro ya tiene.
   */
  @Get('vecinal-pendientes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CGP-VEC.1 — Cierres de ruta vecinal con arqueo conciliado que todavía no entraron al libro. `null` = no se pudo medir (el árbitro no está), que no es lo mismo que «no hay pendientes».' })
  vecinalPendientes(@Query('desde') desde?: string): ReturnType<CashCutService['vecinalPendientes']> {
    return this.cortes.vecinalPendientes(desde);
  }

  @Get('cortes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Cortes de caja. Filtros: from, to, sucursal, estado.' })
  listarCortes(
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('sucursal') sucursal?: string, @Query('estado') estado?: string, @Query('limit') limit?: string,
  ) {
    return this.cortes.listar({ from, to, sucursal, estado, limit: limit ? Number(limit) : undefined });
  }

  /**
   * ⭐⭐ `[CGS.2]` **El arqueo desglosado**: cada corte sellado con los SEIS términos de los que
   * sale su esperado, su conteo pieza por pieza y su veredicto.
   *
   * ⛔ Va ANTES de cualquier `cortes/:id` por la misma razón que `fondo-sugerido` y
   * `jornadas-pendientes`: Nest resuelve por orden de declaración y una ruta con parámetro se
   * come a la literal que venga después.
   *
   * ⚠️ `FINANCE_CAJA_VER`, igual que el resto de las lecturas del módulo, y **no** `AUTORIZAR`:
   * el conteo ciego protege el esperado de un corte que alguien está contando, y acá sólo salen
   * cortes con el conteo **ya sellado** — su esperado ya se reveló a quien lo selló.
   */
  @Get('cortes/arqueos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CGS.2 — Arqueos: lo contado contra la fórmula, término por término' })
  arqueos(
    @Query('desde') desde?: string, @Query('hasta') hasta?: string,
    @Query('sucursal') sucursal?: string, @Query('limit') limit?: string,
  ): ReturnType<CashCutService['arqueos']> {
    return this.cortes.arqueos({ desde, hasta, sucursal, limit: limit ? Number(limit) : undefined });
  }

  /**
   * `[CG.39]` Con qué se propone que arranque la caja: el conteo con el que quedó el último
   * corte cerrado de esa sucursal. Es LECTURA — no abre nada.
   */
  @Get('cortes/fondo-sugerido')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Con qué arrancaría la caja: el cierre del corte anterior, o "sin medir".' })
  fondoSugerido(@Query('sucursal') sucursal?: string) {
    return this.cortes.sugerirFondo(sucursal || SUCURSAL_CAJA_GENERAL);
  }

  /**
   * `[CGP-L.4]` Jornadas con movimientos y sin corte, de la más vieja a la más nueva: lo que la
   * pantalla ofrece cerrar en orden. Va ANTES de `@Get(':id')`, como el resto del archivo.
   */
  @Get('cortes/jornadas-pendientes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CGP-L.4: jornadas del cajón con movimientos y sin corte, en orden. La misma consulta que el sensor del corte abierto.' })
  jornadasPendientes(@Query('sucursal') sucursal?: string): ReturnType<CashCutService['jornadasPendientes']> {
    return this.cortes.jornadasPendientes(sucursal || SUCURSAL_CAJA_GENERAL);
  }

  @Post('cortes')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Abre el corte de la sucursal con su fondo inicial. Uno solo abierto por sucursal.' })
  abrirCorte(@Body() body: AbrirCorteInput, @Req() req: AuthedRequest) {
    return this.cortes.abrir(body, this.user(req));
  }

  /**
   * ⚠️ Era `POST cortes/:id/previa`, cuyo resumen decía «para que el capturista vea la diferencia
   * mientras cuenta» — exactamente lo que CG.19 revierte. Tenía **cero llamadores** (verificado en
   * `apps/view` y `libs/finance`), así que se reusa y se renombra: un endpoint cuyo nombre miente
   * es peor que uno que no existe.
   */
  @Post('cortes/:id/contar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.19 — SELLA el conteo y RECIÉN ENTONCES revela la diferencia. Sellar antes de revelar es lo que vuelve ciego al arqueo: sin eso bastaba mirar el resultado, corregir el conteo y volver a preguntar.' })
  contarCorte(@Param('id') id: string, @Body() body: CerrarCorteInput, @Req() req: AuthedRequest) {
    return this.cortes.contar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/recontar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.19 — Segundo y ÚLTIMO conteo, con motivo obligatorio. El primero se conserva en conteo_previo: un reconteo sin rastro no se distingue de un ajuste.' })
  recontarCorte(@Param('id') id: string, @Body() body: CerrarCorteInput & { motivo?: string }, @Req() req: AuthedRequest) {
    return this.cortes.recontar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/cerrar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Cierra el corte con el conteo fisico. Congela los totales y ata los movimientos. NO se puede cerrar sin contar.' })
  cerrarCorte(@Param('id') id: string, @Body() body: CerrarCorteInput, @Req() req: AuthedRequest) {
    return this.cortes.cerrar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/autorizar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: 'Autoriza el corte. DOBLE LLAVE: quien lo cerro NO puede autorizarlo (lo frena la DB ademas del servicio). [CGS.16] Tampoco quien lo abrio ni quien capturo o cancelo en el. [CGS.17] Un veredicto sin respuesta no se autoriza (se observa) y con diferencia exige nota de 10+ caracteres.' })
  autorizarCorte(@Param('id') id: string, @Body() body: { nota?: string }, @Req() req: AuthedRequest): Promise<CorteCajaDto> {
    return this.cortes.autorizar(id, this.user(req), body ?? {});
  }

  @Get('posicion')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGS.35] Lo que hay en caja, rubro por rubro (cajon, caja fuerte CAOS, dolares, cheques, papeles): lo ultimo contado, lo movido desde entonces y lo que deberia haber. Lo imposible o no medido se declara. El esperado del cajon solo viaja a quien AUTORIZA (arqueo ciego).' })
  posicion(@Req() req: AuthedRequest): Promise<PosicionCajaDto> {
    return this.cortes.posicion(this.revela(req));
  }

  @Get('candado')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGS.14] Si la caja esta bloqueada para quien pregunta (una jornada anterior sin corte cerrado), por que, que lo destraba, y si captura con llave de emergencia. Lectura.' })
  candado(@Req() req: AuthedRequest): Promise<CandadoCaja> {
    return this.cortes.candado(this.user(req));
  }

  @Post('llaves')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[CGS.15] Llave de emergencia: permite a OTRA persona capturar hasta el fin del dia mientras una jornada anterior sigue sin corte. Motivo de 10+. Nadie se la da a si mismo. Solo se agrega.' })
  darLlave(@Body() body: { para_usuario?: string; motivo?: string }, @Req() req: AuthedRequest): Promise<{ vence_at: string; para: string | null }> {
    return this.cortes.darLlave(body ?? {}, this.user(req));
  }

  @Post('cortes/:id/observar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: '[CGS.18] La supervisora devuelve el corte con lo que encontro (motivo de 10+). No cambia ninguna cifra. Misma segregacion que autorizar.' })
  observarCorte(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest): Promise<CorteCajaDto> {
    return this.cortes.observar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/responder')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[CGS.18] La caja responde la observacion (10+) y el corte vuelve a por revisar. Quien observo no se responde a si misma.' })
  responderCorte(@Param('id') id: string, @Body() body: { respuesta?: string }, @Req() req: AuthedRequest): Promise<CorteCajaDto> {
    return this.cortes.responder(id, body ?? {}, this.user(req));
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Cancela un movimiento con motivo. No se borra: se marca y sigue en la lista. No se puede cancelar lo que ya entro a un corte cerrado.' })
  cancelar(@Param('id') id: string, @Body() body: { motivo: string }, @Req() req: AuthedRequest) {
    return this.cortes.cancelarMovimiento(id, body?.motivo, this.user(req));
  }

  /**
   * ⭐⭐ `[CG.128]` **Corrige la cuenta de un movimiento, con rastro.** Hasta hoy no existía: se
   * podía editar una REGLA y cancelar el movimiento, pero cambiarle la cuenta no — por eso los 25
   * ingresos medidos en prod seguían en `102/011`, `201/201` y `607-002/089`.
   *
   * ⛔ La cuenta nueva **no viaja en el cuerpo**: la dice el árbitro (la póliza del propio Kepler).
   * Aceptarla del cliente sería repetir el problema que esto cierra, con un clic menos.
   */
  @Get('por-reclasificar')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.128 — Ingresos SIN SELLAR cuya cuenta contradice a la poliza de Kepler. No corrige: lista.' })
  porReclasificar(): Promise<{ filas: PorReclasificar[]; total: number; monto: number }> {
    return this.cortes.porReclasificar();
  }

  @Post(':id/reclasificar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.128 — Corrige la cuenta de un movimiento a la que dice la poliza de Kepler, guardando el ANTES. Exige motivo (>=12). Lo que ya entro a un corte NO se toca.' })
  reclasificar(@Param('id') id: string, @Body() body: { motivo: string }, @Req() req: AuthedRequest): Promise<Record<string, unknown>> {
    return this.cortes.reclasificar(id, body?.motivo, this.user(req));
  }

  @Get(':id')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Detalle del movimiento con su desglose por denominación y el cuadre del arqueo ya calculado.' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }
}
