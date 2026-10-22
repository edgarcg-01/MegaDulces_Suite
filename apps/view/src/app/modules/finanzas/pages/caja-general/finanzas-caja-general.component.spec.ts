/**
 * CG.22 — Candado de la pantalla de Caja General.
 *
 * Esta pantalla NO tenía una sola prueba (`caja-captura.util.spec.ts` cubre la lógica pura; la
 * pantalla, nada). Por eso sobrevivieron a `nx build`, `nx typecheck` y `check:templates` dos
 * defectos que la dejaban inutilizable, y que sólo se veían abriéndola:
 *
 *   1. `bloqueos = computed(() => motivosDeBloqueo(this.f))` con `f` como CAMPO PLANO. Un
 *      computed sin productores reactivos se evalúa una vez y cachea para siempre: la persona
 *      llenaba el formulario entero y `bloqueos()` seguía devolviendo los motivos del formulario
 *      VACÍO, así que **Guardar quedaba inhabilitado de por vida**. El primer `it` de acá sale
 *      ROJO contra el código anterior — es el que prueba el arreglo.
 *
 *   2. La bandeja se montaba con `@if (pendientes().length || cargandoPend())` y adentro ponía el
 *      vacío con la condición contraria: código inalcanzable. Al filtrar sin resultados
 *      desaparecía la sección entera, con los tres selectores adentro, y no había forma de
 *      deshacer el filtro.
 *
 * Los demás casos son el resto de lo que ADR-056 pide y esta pantalla incumplía: no dibujar
 * ceros cuando no se pudo medir, y no imprimir un monto que el servidor redactó a propósito.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError, Subject } from 'rxjs';

import { DENOMINACIONES_MXN, denomDe, type Denominacion } from '@megadulces/contracts';
import { FinanzasCajaGeneralComponent } from './finanzas-caja-general.component';
 import { CONTEXT_HELP } from '../../../../shared/context-help/context-help.dictionary';
import {
  CashLedgerService, type CoberturaResponse, type LibroResponse, type SaldoResponse,
  type PendientesResponse, type Frecuente, type CajaKepler, type MovimientoPendiente,
  type ArqueoDia, type RecurrentesResponse,
} from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { CajaSocketService, type CajaEvent } from '../../caja-socket.service';
import type { ContextoFirma, CorteRow, FirmaRecibida } from '@megadulces/contracts';
import { todayMx } from '../../../../core/utils/mx-date';

/** jsdom no implementa ResizeObserver y algún componente de PrimeNG lo usa al montar. */
class ResizeObserverStub {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const COBERTURA: CoberturaResponse = {
  catalogo: [
    { sucursal: '00', filas_origen: 900, usables: 820, sin_subcuenta: 80, sin_codigo: 0, sin_nombre: 0 },
    { sucursal: '03', filas_origen: 400, usables: 310, sin_subcuenta: 90, sin_codigo: 0, sin_nombre: 0 },
  ],
  mapa: [],
};

const LIBRO: LibroResponse = {
  rows: [],
  kpi: { movimientos: 12, ingresos: 1000, gastos: 400, depositos: 600 },
  limit: 100, offset: 0, has_more: false,
};

const SALDO: SaldoResponse = {
  sucursal: '00', corte_abierto: null, saldo: 500, saldo_oculto: false, sin_corte_abierto: true,
  movimientos_sueltos: 0,
  totales: {
    ingresos: 0, gastos: 0, depositos: 0, contado: 0, movimientos: 0, cancelados: 0,
    ingresos_anclados: 0, ingresos_capturados: 0, cobertura_ingreso: null,
  },
};

const VACIA: PendientesResponse = {
  rows: [], limit: 100, has_more: false, confirmables: 0, desde: '2026-09-21', ventana_dias: 1,
};

/** Una fila real de la bandeja: un pago de caja chica SIN cuenta declarada. Es el caso que
 *  dejaba el arqueo muerto — con 0 reglas de gasto, todas las filas se ven así. */
const GASTO_TRABADO: MovimientoPendiente = {
  origen_ref: '00|X-D-26|0001298|0011',
  tipo: 'gasto', origen_tipo: 'pago_proveedor', clave_banco: '0011',
  caja_nombre: 'CAJA GENERAL', sucursal: '00', doc_tipo: 'X-D-26', folio: '0001298',
  fecha_valor: '2026-12-10', entidad_code: 'GG015',
  beneficiario: 'GASTOS GENERALES CAJA CHICA MORELIA ABASTOS',
  concepto: null, metodo: null, monto: 1060,
  confirmable: false, kepler_cuenta: null, kepler_concepto: null,
  motivo: 'sin_regla', motivo_texto: 'Nadie declaró con qué cuenta contable se registra.',
};

const CON_GASTO: PendientesResponse = {
  rows: [GASTO_TRABADO], limit: 100, has_more: false, confirmables: 0,
  desde: '2026-09-21', ventana_dias: 1,
};

/** Dos filas CONFIRMABLES: contar es recorrer una columna, y con una sola no se prueba nada. */
const FILA_A: MovimientoPendiente = {
  ...GASTO_TRABADO, origen_ref: '00|X-D-26|0001294|0011', folio: '0001294', monto: 250,
  confirmable: true, kepler_cuenta: '601-001', kepler_concepto: 'VIATICOS', motivo: undefined, motivo_texto: undefined,
};
const FILA_B: MovimientoPendiente = {
  ...FILA_A, origen_ref: '00|X-D-26|0001295|0011', folio: '0001295', monto: 3747.66,
};
const CON_DOS: PendientesResponse = {
  rows: [FILA_A, FILA_B], limit: 100, has_more: false, confirmables: 2,
  desde: '2026-09-21', ventana_dias: 1,
};

/** CS.3.13 — Un cobro de un cliente de CRÉDITO (kdud días/límite > 0), listo para capturar. */
const COBRO_CREDITO: MovimientoPendiente = {
  origen_ref: '00|U-A-5|0002100|0011', tipo: 'ingreso', origen_tipo: 'cobro', clave_banco: '0011',
  caja_nombre: 'CAJA GENERAL', sucursal: '00', doc_tipo: 'U-A-5', folio: '0002100',
  fecha_valor: '2026-09-28', entidad_code: '40-00', beneficiario: 'P.V. 8 Esquinas',
  concepto: null, metodo: null, monto: 1000,
  confirmable: true, kepler_cuenta: '115', kepler_concepto: '001',
  cliente_credito: true, credito_limite: 400000, credito_dias: 0,
};

const FRECUENTE: Frecuente = {
  kepler_cuenta: '601-001', kepler_concepto: 'PAPELERIA', glosa: 'hojas',
  beneficiario: 'PAPELERA SA', usos: 9, ultimo_uso: '2026-09-20', rango: 1,
};

const CAJAS: CajaKepler[] = [
  { clave: '0011', nombre: 'CAJA GENERAL', cuenta_contable: '102-0011', documentos: 9142 },
  { clave: '0030', nombre: 'CAJA CHICA MORELIA ABASTOS', cuenta_contable: '102', documentos: 0 },
];

/**
 * `[CG.26]` El cierre de la jornada. La fixture usa el día REAL que destapó el defecto:
 * **2026-09-08**, el único de las últimas semanas con `Dotar` y `Vaciar Stocks`. Con los dos tipos
 * que la conciliación vieja miraba (0 y 4) el neto daba **$84,640**; con los cuatro que mueven
 * efectivo da **$61,640**. $23,000 de diferencia en un solo día.
 */
const ARQUEO: ArqueoDia = {
  fecha: '2026-09-08',
  sucursal: '00',
  caja_general: { movimientos: 3, cancelados: 1, ingresos: 5000, gastos: 1200, depositos: 800, neto: 3000 },
  cajero: {
    por_tipo: [
      { type_id: 0, etiqueta: 'Deposito', movimientos: 6, monto: 101540, desconocido: false },
      { type_id: 4, etiqueta: 'Dispensar', movimientos: 3, monto: 16900, desconocido: false },
      { type_id: 5, etiqueta: 'Vaciar Stocks', movimientos: 2, monto: 566900, desconocido: false },
      { type_id: 8, etiqueta: 'Dotar', movimientos: 5, monto: 543900, desconocido: false },
      { type_id: 13, etiqueta: 'Contenido Modificado', movimientos: 1, monto: 20, desconocido: false },
    ],
    entra: 645440, sale: 583800, neto: 61640,
    depositado: 101540, dispensado: 16900, dotado: 543900, vaciado: 566900,
    movimientos: 17, tipos_desconocidos: [], ultimo_movimiento: '2026-09-08T18:00:00-06:00',
  },
  corte_abierto: null,
  no_medido: ['Del cajero se cuadra el FLUJO del día, no su contenido: CAOS no publica cuánto efectivo tiene adentro.'],
};

/**
 * `[CG.27-B.1]` Los recurrentes sin regla, con las proporciones REALES de prod: 58 que repiten,
 * 57 sin regla, y sólo **3** a los que la contabilidad puede proponerles la cuenta.
 */
const RECURRENTES: RecurrentesResponse = {
  rows: [
    {
      beneficiario: 'GASTOS GENERALES CAJA CHICA MORELIA ABASTOS',
      pagos: 967, pagos_con_regla: 0, monto: 706742, promedio: 731,
      cv_importe: 3.39, ultimo_pago: '2026-09-21', dias_sin_pago: 8, propuesta_contable: null,
    },
    {
      beneficiario: 'CAPITAN DE MARCA',
      pagos: 313, pagos_con_regla: 0, monto: 116550, promedio: 372,
      cv_importe: 0.36, ultimo_pago: '2026-09-18', dias_sin_pago: 11,
      propuesta_contable: { kepler_cuenta: '606-014', kepler_concepto: '074', soporte: 447, dominancia: 1 },
    },
    {
      beneficiario: 'ARTURO VILLARRUEL SAINZ',
      pagos: 23, pagos_con_regla: 0, monto: 1460355, promedio: 63494,
      cv_importe: 1.2, ultimo_pago: '2026-08-27', dias_sin_pago: 33, propuesta_contable: null,
    },
  ],
  ventana_dias: 180,
  min_pagos: 15,
  medido: {
    recurrentes: 58, sin_regla: 57, pagos_sin_regla: 5688,
    reglas_declaradas: 1, caidos: 11,
    con_propuesta_contable: 3, sin_de_donde_proponer: 54,
  },
  caido_dias: 21,
};

describe('FinanzasCajaGeneralComponent · CG.22', () => {
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  let comp: FinanzasCajaGeneralComponent;

  /** El canal en vivo, de mentira: las pruebas empujan eventos con `cajaSock.change$.next(...)`. */
  // `[CG.68]` El doble lleva TAMBIEN los tres avisos del emparejamiento y los cuatro mensajes.
  // ⚠️ Sin ellos `suscribirCambios` revienta en `.pipe` de undefined -- la pantalla lo atrapa y
  // degrada ("sin avisos en vivo"), asi que el defecto no se ve como error sino como una prueba
  // suelta que falla por otra cosa. Un doble incompleto miente sobre el contrato.
  let cajaSock: {
    connect: () => void; disconnect: () => void; change$: Subject<CajaEvent>;
    connected: () => boolean;
    /**
     * [AUD] El doble lleva TAMBIEN el estado del canal. Esta pantalla todavia no lo lee -- usa
     * `socketVivo()`, que sale de `connected` -- pero el servicio ya lo publica, y un doble al
     * que le falta una pieza del contrato miente sobre el contrato (lo dice el comentario de
     * arriba, y se cumple aunque hoy no se note).
     */
    estado: () => 'sin_iniciar' | 'conectando' | 'vivo' | 'caido';
    firmaTomada$: Subject<{ codigo: string; por: string | null }>;
    firmaRecibida$: Subject<FirmaRecibida>;
    firmaCortada$: Subject<{ codigo: string }>;
    /** `[CG.84]` `pase` es lo que deja firmar SIN sesión: va dentro del QR. */
    abrirFirma: (c: ContextoFirma) => Promise<{ ok: boolean; codigo?: string; pase?: string }>;
    tomarFirma: (c: string) => Promise<{ ok: boolean }>;
    enviarFirma: (c: string, p: string, n: string | null) => Promise<{ ok: boolean }>;
    cerrarFirma: () => Promise<{ ok: boolean }>;
  };

  function montar(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    cajaSock = {
      connect: vi.fn(), disconnect: vi.fn(), change$: new Subject<CajaEvent>(), connected: () => false,
      // Coherente con `connected: () => false`: en jsdom el canal nunca abre, y el estado que le
      // corresponde a eso es `caido`, no un `conectando` eterno.
      estado: () => 'caido' as const,
      firmaTomada$: new Subject(), firmaRecibida$: new Subject(), firmaCortada$: new Subject(),
      abrirFirma: vi.fn(async () => ({ ok: true, codigo: 'ABC234' })),
      tomarFirma: vi.fn(async () => ({ ok: true })),
      enviarFirma: vi.fn(async () => ({ ok: true })),
      cerrarFirma: vi.fn(async () => ({ ok: true })),
    };
    svc = {
      cobertura: vi.fn(() => of(COBERTURA)),
      libro: vi.fn(() => of(LIBRO)),
      saldo: vi.fn(() => of(SALDO)),
      cortes: vi.fn(() => of({ rows: [] })),
      cajas: vi.fn(() => of({ rows: CAJAS, ventana_dias: 1 })),
      movimientosPendientes: vi.fn(() => of(VACIA)),
      caosCapturables: vi.fn(() => of({ rows: [], limit: 100, has_more: false, desde: '2026-09-21' })),
      caosCandidatos: vi.fn(() => of({ rows: [], fecha: '2026-09-24', datos_al: null })),
      frecuentes: vi.fn(() => of({ rows: [FRECUENTE] })),
      autofill: vi.fn(() => of({ concepto: null, provenance: null })),
      conceptos: vi.fn(() => of({ rows: [] })),
      crear: vi.fn(() => of({ id: 'm1' })),
      declararRegla: vi.fn(() => of({ creada: true, id: 'r1' })),
      confirmarLote: vi.fn(() => of({ filas: [], guardados: 0, duplicados: 0, rechazados: 0, no_confirmables: 0, monto_guardado: 0 })),
      arqueoDia: vi.fn(() => of(ARQUEO)),
      recurrentesSinRegla: vi.fn(() => of(RECURRENTES)),
      abrirCorte: vi.fn(() => of({ id: 'c1', folio: 'CC-2026-00001' })),
      // [CGP-V.3] Sin jornadas atrasadas: el caso de todos los días.
      jornadasPendientes: vi.fn(() => of({ sucursal: '00', hoy: todayMx(), inicio_libro: null, jornadas: [], alcance: 'cajon' })),
      // `[CGS.14]` Por omisión la caja está libre: las pruebas del candado lo sobrescriben.
      candado: vi.fn(() => of({ bloqueado: false, motivo: null, jornada: null, texto: null, con_llave: null, activo: true, hoy: todayMx(), pueden_recibir_llave: [] })),
      ...over,
    };

    TestBed.configureTestingModule({
      imports: [FinanzasCajaGeneralComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: CashLedgerService, useValue: svc },
        // `token: () => null` NO es relleno: `CajaSocketService.connect()` lo pide, y sin él
        // `ngOnInit` reventaba y caían las 46 pruebas de una. Devolver null deja el socket sin
        // abrir —que es lo que queremos en jsdom— y ejercita el camino "sin canal en vivo".
        { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }), token: () => null } },
        // El socket real abriría una conexión de verdad desde jsdom. Acá se reemplaza por un
        // Subject que las pruebas empujan a mano: así se ejercita lo que la pantalla HACE con
        // el aviso, que es lo único nuestro en ese camino.
        { provide: CajaSocketService, useValue: cajaSock },
      ],
    });

    const fixture = TestBed.createComponent(FinanzasCajaGeneralComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    return fixture;
  }

  /**
   * `[CGS.7]` El folio en grande: las dos ramas que no son obvias.
   *
   * ⛔ La del timer importa porque un segundo pago antes de que cierre el primero reiniciaba
   * mal: el timer viejo cerraba el folio nuevo a los pocos segundos de aparecer.
   */
  describe('[CGS.7] el folio para anotar', () => {
    it('sin folio no abre el dialogo', () => {
      montar();
      const c = comp as unknown as { mostrarFolio(v: unknown): void };
      for (const v of [null, undefined, '', '   ']) {
        c.mostrarFolio(v);
        expect(comp.folioPagado()).toBeNull();
      }
    });

    it('se cierra solo a los 10 s, y un folio nuevo reinicia la cuenta', () => {
      vi.useFakeTimers();
      try {
        montar();
        const c = comp as unknown as { mostrarFolio(v: unknown): void };
        c.mostrarFolio('CG-2026-00311');
        expect(comp.folioPagado()).toBe('CG-2026-00311');

        vi.advanceTimersByTime(9000);
        expect(comp.folioPagado()).toBe('CG-2026-00311');

        // Llega el segundo pago faltando 1 s: la cuenta vuelve a empezar.
        c.mostrarFolio('CG-2026-00312');
        vi.advanceTimersByTime(9000);
        expect(comp.folioPagado()).toBe('CG-2026-00312');

        vi.advanceTimersByTime(1000);
        expect(comp.folioPagado()).toBeNull();
      } finally { vi.useRealTimers(); }
    });

    it('el boton lo cierra antes, y el timer ya no dispara', () => {
      vi.useFakeTimers();
      try {
        montar();
        (comp as unknown as { mostrarFolio(v: unknown): void }).mostrarFolio('CI-2026-00117');
        comp.cerrarFolio();
        expect(comp.folioPagado()).toBeNull();
        // Prueba negativa: si el timer siguiera vivo, acá reabriría o reventaría.
        vi.advanceTimersByTime(20000);
        expect(comp.folioPagado()).toBeNull();
      } finally { vi.useRealTimers(); }
    });
  });
  // localStorage persiste entre pruebas en jsdom: un borrador de la prueba anterior haria
  // pasar (o fallar) a la siguiente por el motivo equivocado.
  beforeEach(() => { try { localStorage.clear(); } catch { /* sin storage */ } });
  afterEach(() => TestBed.resetTestingModule());

  /**
   * CG.23 — Cuenta efectivo como lo hace la persona: piezas por denominación.
   *
   * El monto SALE del conteo, así que una prueba que lo teclee con `setF('monto', …)` o
   * con `onMonto(…)` arma un formulario que la pantalla real **ya no puede producir** — y se
   * pondría verde sobre un estado inexistente. Todas las pruebas de acá cuentan.
   */
  /**
   * ⚠️ `[CG.38]` La llave es un STRING del catálogo compartido, no el valor. `contar({500: 2})`
   * sigue funcionando igual —`Object.entries` ya entrega `'500'`— y además ahora se puede contar
   * la moneda de $20 con `contar({'20m': 3})`, que antes era indistinguible del billete.
   */
  const den = (k: string | number): Denominacion => {
    const d = denomDe(String(k));
    if (!d) throw new Error('La prueba pide la denominacion "' + k + '", que no existe en el catalogo.');
    return d;
  };
  /**
   * `[CG.59]` Monta y ABRE la jornada. Desde el rediseno, el cierre del dia, el cajero, los
   * recurrentes, los pagables y el historial viven dentro del desplegable del 10%: la barra
   * cerrada ya dice como va, y lo demas se abre. Lo que estas pruebas afirman no cambio --
   * cambio DONDE esta, y por eso abren el desplegable en vez de aflojar la asercion.
   */
  const montarJornada = (svcPatch?: Record<string, unknown>) => {
    const fx = montar(svcPatch as never);
    comp.jornadaAbierta.set(true);
    fx.detectChanges();
    return fx;
  };

  /**
   * `[CG.123]` **Abre la jornada EN una de sus tres partes.**
   *
   * Desde que el diálogo tiene selector, «la jornada está abierta» ya no implica que todo esté
   * pintado: cada parte se monta cuando se la elige. Las pruebas que miran «Pendientes» o
   * «Historial» tienen que decir dónde están paradas — que es exactamente lo que hace la persona.
   *
   * ⚠️ Lo que esto **no** afloja: que una parte exista sigue comprobándose. Si un bloque se
   * perdiera en la mudanza, elegir su sección lo dejaría vacío y la prueba se pondría roja igual.
   */
  const montarJornadaEn = (
    seccion: 'hoy' | 'pendientes' | 'historial',
    svcPatch?: Record<string, unknown>,
  ) => {
    const fx = montarJornada(svcPatch);
    comp.seccionJornada.set(seccion);
    fx.detectChanges();
    return fx;
  };

  const contar = (piezas: Record<string, number>): void => {
    for (const [k, n] of Object.entries(piezas)) comp.setPiezas(den(k), n);
  };

  // ── 1 · El defecto que rompía la pantalla ────────────────────────────────────────────────

  it('Guardar se HABILITA cuando el formulario queda completo (rojo con el computed congelado)', () => {
    montar();
    comp.abrirCaptura();

    // Primera lectura: el formulario recién abierto SÍ tiene motivos. Leerla acá es lo que
    // dejaba la caché envenenada en la versión anterior.
    expect(comp.bloqueos().length).toBeGreaterThan(0);

    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });

    expect(comp.bloqueos()).toEqual([]);
    // El monto no se tecleó: salió del conteo.
    expect(comp.f().monto).toBe(1500);
  });

  it('y al vaciar un campo vuelve a bloquear (no es que quedó abierto para siempre)', () => {
    montar();
    comp.abrirCaptura();
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });
    expect(comp.bloqueos()).toEqual([]);

    // Deshacer el conteo devuelve el monto a cero y vuelve a frenar.
    contar({ 500: 0 });
    expect(comp.f().monto).toBe(0);
    expect(comp.bloqueos()).toContain('falta_desglose');
  });

  // ── 2 · La bandeja no se desmonta ────────────────────────────────────────────────────────

  it('sin resultados, los selectores de la bandeja SIGUEN en pantalla', () => {
    const fixture = montar();
    expect(comp.pendientes().length).toBe(0);

    const html: string = fixture.nativeElement.innerHTML;
    expect(html).toContain('movimientos por confirmar');

    // ⛔ `[CG.51]` Esto decía "los tres p-select viven en el encabezado de la sección" y contaba
    // `p-select` de TODA la página — el tercero vivía en los filtros del libro, 300 líneas abajo.
    // Pasaba por acumulación, no por lo que afirmaba. Lo destapó plegar el historial.
    // Lo que importa es que los filtros DE LA BANDEJA sigan ahí: con la lista vacía, si la sección
    // se desmonta la persona queda encerrada con el filtro puesto y sin forma de sacarlo.
    const bandeja: Element | null = fixture.nativeElement.querySelector('.cg-bandeja');
    expect(bandeja).not.toBeNull();
    // [CGA-A.43] La ventana se quitó: queda sólo el selector de caja.
    expect(bandeja!.querySelectorAll('p-select').length).toBe(1);   // caja
    expect(bandeja!.querySelectorAll('app-segmented').length).toBe(1); // entra / sale
    expect(bandeja!.querySelectorAll('input[type="search"], input.cg-buscar').length).toBe(1);
  });

  it('un error de red en la bandeja se DECLARA, no se ve como "no hay nada"', () => {
    montar({ movimientosPendientes: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    expect(comp.errPend()).toBeTruthy();
    expect(comp.pendientes().length).toBe(0);
    // La diferencia es toda: vacío medido vs. no se pudo medir.
    expect(comp.errPend()).not.toBe(null);
  });

  // ── 3 · No dibujar ceros ni montos redactados (ADR-056) ──────────────────────────────────

  it('sin libro medido, los KPIs dicen "sin medir" — NO $0.00', () => {
    montar({ libro: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    const kpis = comp.kpis();
    expect(kpis.every((k) => k.value === '—')).toBe(true);
    expect(kpis.every((k) => k.sub === 'sin medir')).toBe(true);
    expect(kpis.some((k) => String(k.value).includes('0'))).toBe(false);
  });

  it('con libro medido, los KPIs publican la cifra', () => {
    montar();
    expect(comp.kpis()[0].value).toBe('12');
  });

  it('el arqueo OCULTO no imprime un monto: $0.00 se leería como "cuadra a cero"', () => {
    // [CGP-V.2] Lo sellado en la sesión va atado a SU corte: se monta uno abierto y se abre el diálogo.
    const fixture = montar({
      saldo: vi.fn(() => of({
        ...SALDO, sin_corte_abierto: false,
        corte_abierto: { id: 'c1', folio: 'CC-2026-00001', fondo_inicial: 500, ya_reconto: false, conteo_sellado: null },
      } as unknown as SaldoResponse)),
    });
    comp.abrirCierre();
    comp.revelado.set({
      corteId: 'c1', puedeRecontar: false, conteo: [], morralla: 0,
      totales: {
        ingresos: 0, gastos: 0, depositos: 0, contado: 900, movimientos: 3, cancelados: 0,
        ingresos_anclados: 0, ingresos_capturados: 0, cobertura_ingreso: null, oculto: true,
      },
    });
    // Que la prueba ejerza el caso: la revelación oculta tiene que estar vigente.
    expect(comp.revelacion()?.oculto).toBe(true);
    comp.cuadreAbierto.set(true);
    fixture.detectChanges();

    const html: string = document.body.innerHTML + fixture.nativeElement.innerHTML;
    expect(html).not.toContain('Esperado:');
    expect(html).not.toContain('Diferencia:');
  });

  // ── 4 · Lo que el servidor dice, y la zona horaria ───────────────────────────────────────

  it('la ventana publicada sale de la RESPUESTA, no del selector local', () => {
    montar({
      movimientosPendientes: vi.fn(() => of({ ...VACIA, ventana_dias: 45, desde: '2026-08-08' })),
    });
    expect(comp.ventanaSrv()?.dias).toBe(45);
    // `[CG.45]` Antes era `textoBandeja()`. Esa frase juntaba cinco hechos en un renglón gris y
    // se partió: la cifra accionable va en la cabecera con peso, el ALCANCE queda acá, y la edad
    // del dato se fue a `app-freshness-pill`. Lo que esta prueba vigila —que la ventana salga de
    // la RESPUESTA y no del selector local— no cambió.
    expect(comp.textoAlcance()).toContain('45 días');
  });

  it('avisa cuando la lista viene TOPADA (has_more)', () => {
    montar({ movimientosPendientes: vi.fn(() => of({ ...VACIA, has_more: true })) });
    expect(comp.truncada()).toBe(true);
  });

  it('el movimiento nace con la fecha de MÉXICO, no la de UTC', () => {
    montar();
    comp.abrirCaptura();
    expect(comp.f().fecha).toBe(todayMx());
  });

  // ── 5 · Los frecuentes son POR SUCURSAL ──────────────────────────────────────────────────

  it('los frecuentes se piden con la sucursal que se está capturando', () => {
    montar();
    comp.onSucursal('03');
    const ultima = svc['frecuentes'].mock.calls.at(-1)?.[0];
    expect(ultima.sucursal).toBe('03');
  });

  // `[CG.97]` El eje gemelo del de arriba. El `tipo` iba clavado en 'gasto', así que capturando
  // un ingreso se ofrecían los pares de los GASTOS de esa persona: chips que llenan una cuenta
  // del universo equivocado. Es el mismo defecto que la sucursal ya tenía resuelto.
  it('los frecuentes se piden con el TIPO que se está capturando, no con gasto fijo', () => {
    montar();
    comp.onTipo('ingreso');
    const ultima = svc['frecuentes'].mock.calls.at(-1)?.[0];
    expect(ultima.tipo).toBe('ingreso');
  });

  // Prueba negativa de la MISMA guarda: cambiar de tipo tiene que RE-PEDIR. Sin la llamada en
  // `onTipo` el parámetro sería correcto y los chips en pantalla seguirían siendo los viejos —
  // el bug se vería igual y este archivo estaría verde.
  it('cambiar de tipo vuelve a pedir la lista, no se queda con la anterior', () => {
    montar();
    const antes = svc['frecuentes'].mock.calls.length;
    comp.onTipo('deposito');
    expect(svc['frecuentes'].mock.calls.length).toBeGreaterThan(antes);
  });

  // ── 6 · La procedencia no miente ─────────────────────────────────────────────────────────

  it('elegir el concepto a mano deja de decir "propuesto"', () => {
    montar();
    comp.propuesta.set({
      concepto: { value: { kepler_cuenta: '601-001', kepler_concepto: 'X' }, source: 'contexto', confidence: 0.8, support: 12, supportRatio: 0.8 },
    } as never);
    expect(comp.etiquetaConcepto().tono).toBe('propuesto');

    comp.elegirConcepto({ value: { cuenta: '602-002', concepto: 'Y' } } as never);
    expect(comp.etiquetaConcepto().tono).toBe('manual');
  });

  // ── 7 · Cobertura: medir cero != no poder medir ──────────────────────────────────────────

  it('si la cobertura no se pudo medir, NO se afirma "no hay conceptos" ni se traba la captura', () => {
    montar({ cobertura: vi.fn(() => throwError(() => ({ status: 0 }))) });
    expect(comp.coberturaSinMedir()).toBe(true);
    expect(comp.hayConceptos()).toBe(false);
    // El botón se bloquea sólo con cobertura MEDIDA en cero.
    const trabado = !comp.hayConceptos() && !comp.coberturaSinMedir();
    expect(trabado).toBe(false);
  });

  it('con cobertura medida en cero, SÍ se traba y se dice por qué', () => {
    montar({ cobertura: vi.fn(() => of({ catalogo: [], mapa: [] })) });
    expect(comp.coberturaSinMedir()).toBe(false);
    expect(comp.hayConceptos()).toBe(false);
  });

  // ── 8 · El ARQUEO: contar un movimiento, aunque su cuenta no esté declarada ───────────────
  //
  // Reportado por Edgar sobre la pantalla en vivo: "no me deja ingresar el arqueo de cada
  // ingreso o egreso". El input de Contado tenía `[disabled]="!p.confirmable"` — y con 0 reglas
  // de gasto TODAS las filas son no-confirmables, así que el arqueo estaba muerto en toda la
  // pantalla. Contar es un hecho físico; que su cuenta esté declarada es una decisión
  // administrativa. El efectivo ya está en la caja, se registre o no.

  // ⭐ `[CG.48]` Y después Edgar lo dio vuelta: *"este botón no debe existir, se debe generar un
  // arqueo a todo y este botón no cumple esa función"*. La columna era una TERCERA forma de contar
  // el mismo dinero y la única sin desglose — `assertArqueo` dejaba las denominaciones opcionales,
  // así que un lote confirmado entraba al libro con monto y sin un billete declarado detrás, y el
  // arqueo del día no se podía reconstruir desde el libro que lo registró.
  //
  // Las pruebas de abajo son NEGATIVAS a propósito: afirman que el camino ya no existe.

  it('[negativa] la bandeja NO tiene ningún campo de importe: contar no se hace acá', async () => {
    const fixture = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    // ⚠️ El await sigue siendo necesario: `NgModel` aplica el estado deshabilitado en un
    // microtask, DESPUÉS de `detectChanges()`. Sin él, una aserción sobre `disabled` miente.
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('input.cg-contado')).toBeNull();
    // Y no es que se renombró: en el cuerpo de la bandeja no queda NINGÚN input numérico.
    expect(fixture.nativeElement.querySelectorAll('tbody input[type="number"]').length).toBe(0);

    // Lo que NO cambió: la fila trabada sigue sin poder marcarse. Confirmar sin cuenta
    // declarada no se puede, y eso es independiente de dónde se cuente el efectivo.
    //
    // ⭐ `[CG.55]` Y la afirmación se ENDURECE: antes había una casilla deshabilitada, hoy **no hay
    // casilla**. Una casilla apagada en oscuro se ve casi igual que una viva, así que la columna
    // ofrecía 44 veces algo que podía hacer 23. Lo que la fila sí puede hacer lo dicen su etiqueta
    // de motivo y su botón «Capturar».
    expect(fixture.nativeElement.querySelector('tbody p-checkbox')).toBeNull();
  });

  // ── [CG.56] Sin casillas: la fila ES el control ──────────────────────────────────────────
  //
  // Decisión de Edgar: *"hazlo, no son necesarias"*. La columna de casillas se retiró entera.
  // El camino quedó uno: `pSelectableRow` ([CG.50]) hace la fila seleccionable con clic, con
  // Space y con las flechas. Lo que una casilla daba y una fila no —ver el estado de un
  // vistazo— lo da `.cg-fila-marcada`.

  it('⛔ [negativa] no queda NINGUNA casilla en la bandeja', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();
    expect(fx.nativeElement.querySelectorAll('.cg-bandeja-tbl p-checkbox').length).toBe(0);
  });

  // ── [CG.61] La cola, compacta: media pantalla no da para ocho columnas ────────────────────
  //
  // Con la cola dentro del apartado 1 (`[CG.60]`) la tabla tiene **media pantalla**, y
  // `check:dense-tables` la marcó en deuda por ancho de columnas (9, tracker `[UIM.2]`).
  // Se retiran dos columnas — pero lo que se retira es la COLUMNA, no el dato: el documento
  // baja a su fila, que es donde el tablero lo pone.

  it('la cola cabe en media pantalla: seis columnas, y el documento NO se perdió', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const ths = fx.nativeElement.querySelectorAll('.cg-bandeja-tbl thead th');
    expect(ths.length, 'la cola volvió a crecer: ocho columnas no se leen en media pantalla')
      .toBeLessThanOrEqual(6);

    // ⭐ Y la prueba que impide "arreglarlo" borrando: el documento tiene que SEGUIR en la fila.
    // Sin esto, cortar columnas puntúa igual que perder el dato con el que se identifica el
    // movimiento, y el buscador promete justamente "folio Kepler".
    const fila: HTMLElement = fx.nativeElement.querySelector('.cg-bandeja-tbl tbody tr');
    expect(fila.querySelector('.cg-fila-doc')?.textContent)
      .toContain(FILA_A.folio);
  });

  // ── [CG.63] La FILA es el botón ──────────────────────────────────────────────────────────
  //
  // Edgar: *"no le estás dando visibilidad, además lo especificás como si fuera algo secundario,
  // es el botón principal de la interacción. me gustaría que al darle clic a todo el movimiento
  // se despliegue el menú"*. `[CG.61]` había pasado la salida a un icono de 2rem en el borde
  // derecho — y pintarlo más fuerte no lo iba a convertir en el control principal de un renglón.

  it('⛔ [negativa] NO queda un botón por fila: la fila entera abre el movimiento', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    expect(
      fx.nativeElement.querySelectorAll('.cg-bandeja-tbl tbody tr button').length,
      'volvió un botón por fila: la acción principal no puede ser un control de 2rem al borde',
    ).toBe(0);

    // La tabla selecciona DE A UNA, y seleccionar significa abrir. Con selección múltiple el
    // clic volvería a marcar para el lote, que es justo lo que se cambió.
    const tabla: HTMLElement = fx.nativeElement.querySelector('.cg-bandeja-tbl');
    expect(tabla.getAttribute('selectionmode') ?? tabla.getAttribute('selectionMode'))
      .not.toBe('multiple');

    // Y la fila DICE que abre, antes del clic: el galón que apunta a dónde va.
    const fila: HTMLElement = fx.nativeElement.querySelector('.cg-bandeja-tbl tbody tr');
    expect(fila.querySelector('.cg-td-abrir .pi-chevron-right'), 'la fila no anuncia que abre')
      .not.toBeNull();
  });

  it('⭐⭐ EL CLIC REAL abre, caiga donde caiga dentro de la fila', async () => {
    // ⛔ Reportado por Edgar: «estoy dando clic y no me despliega la información». Las pruebas de
    // `[CG.63]` llamaban a `abrirDeLaCola(...)` — el MÉTODO — así que ninguna podía ver si el clic
    // del navegador llega hasta ahí. Es exactamente el pie que `[CG.62]` ya había pisado con el
    // botón de Guardar, repetido doce líneas más abajo. Ésta entra por el `<tr>`.
    //
    // ⭐ Y no clickea una celda cómoda: recorre TODAS las celdas de la fila, incluida la del
    // galón y la de la marca. El `handleRowClick` de PrimeNG se descarta solo cuando el blanco —o
    // su padre— es `INPUT/TEXTAREA/BUTTON/A`, o tiene un `.p-button/.p-checkbox/.p-radiobutton`
    // por encima (leído en `@primeuix/utils`). Una prueba que apunte siempre al mismo `<td>`
    // puede pasar con la mitad de la fila muerta.
    const celdas = (fx: { nativeElement: HTMLElement }) =>
      Array.from(
        fx.nativeElement.querySelectorAll('.cg-bandeja-tbl tbody tr:first-child td'),
      ) as HTMLElement[];

    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();
    expect(celdas(fx).length, 'no hay filas').toBeGreaterThan(0);

    for (let i = 0; i < celdas(fx).length; i++) {
      comp.cerrarConFoco(comp.capturaAbierta);
      fx.detectChanges();
      expect(comp.capturaAbierta()).toBe(false);

      // El blanco real es lo MÁS profundo de la celda, que es donde cae el dedo.
      const td = celdas(fx)[i];
      const blanco = (td.querySelector('*') as HTMLElement) ?? td;
      blanco.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fx.detectChanges();

      expect(comp.capturaAbierta(), 'la celda ' + i + ' no abre la captura').toBe(true);
      expect(comp.cobroElegido()?.origen_ref).toBe(FILA_A.origen_ref);
    }
  });

  // ── [CG.67] La firma de conformidad ──────────────────────────────────────────────────────
  //
  // Edgar: *"necesito que anejemos una firma digital… para que pueda firmar e imprimir su ticket
  // digital"*. El ticket de esta pantalla ya imprimía `"Recibi conforme (nombre y firma)"`: la
  // firma existía, en papel. Esto la vuelve dato. Sólo el gasto la pide.

  // ── ⛔⛔ [CG.69] La clase que YA EXISTÍA y era un `sr-only` ────────────────────────────────
  //
  // Reportado por Edgar con captura: los dos apartados con su encabezado visible y **el cuerpo
  // vacío**. No era la lógica — se midió y el clic abre, y `capturaAbierta()` queda en `true` con
  // la reja renderizada.
  //
  // Era esto: en `[CG.63]` envolví el contenido de los dos apartados en `<div class="cg-cap …">`
  // sin comprobar que `.cg-cap` **ya existía en este mismo archivo** como la mordaza de
  // accesibilidad (`position:absolute; width:1px; height:1px; overflow:hidden`) de tres leyendas
  // de tabla. Las dos reglas no compiten: **se suman**. Los apartados quedaron `display:flex` Y
  // `1×1 px con overflow:hidden`.
  //
  // ⚠️ Y NADA lo veía: `check:tokens` pasa (los tokens existen), `check:templates` pasa (el CSS
  // parsea), y las 175 pruebas pasan porque **jsdom no aplica CSS**. En un archivo de 4,500
  // líneas, elegir un nombre de clase sin buscarlo primero es apostar.

  it('⛔ [negativa] ninguna clase sr-only se reusa como envoltorio de layout', () => {
    const fuente = FinanzasCajaGeneralComponent as unknown as { ɵcmp?: { styles?: string[] } };
    const css = (fuente.ɵcmp?.styles ?? []).join('\n');

    // Las clases amordazadas: las que se esconden con el truco de 1px. Son para lectores de
    // pantalla y NO pueden envolver nada que tenga que verse.
    const mordazas = new Set<string>();
    for (const regla of css.match(/\.[A-Za-z0-9_-]+\[_ngcontent[^{]*\{[^}]*\}/g) ?? []) {
      if (/width\s*:\s*1px/.test(regla) && /height\s*:\s*1px/.test(regla)) {
        const n = regla.match(/\.([A-Za-z0-9_-]+)\[/);
        if (n) mordazas.add(n[1]);
      }
    }
    expect(mordazas.size, 'no se encontró ninguna clase sr-only: el detector quedó ciego')
      .toBeGreaterThan(0);

    // Y ninguna de ellas puede estar declarada OTRA VEZ con layout: eso las suma, no las pisa.
    const reincidentes = [...mordazas].filter((c) => {
      const reglas = css.match(new RegExp('\\.' + c + '\\[_ngcontent[^{]*\\{[^}]*\\}', 'g')) ?? [];
      return reglas.some((r) => /display\s*:\s*(flex|grid|block)/.test(r));
    });
    expect(reincidentes, 'una clase sr-only también declara layout: ' + reincidentes.join(', '))
      .toEqual([]);
  });

  it('⛔ [negativa] el envoltorio de la captura NO está amordazado', () => {
    // El candado de arriba mira el CSS; éste mira el DOM, que es por donde entró el defecto.
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();

    for (const sel of ['.cg-ap-que .cg-captura', '.cg-ap-arqueo .cg-captura']) {
      const el: HTMLElement | null = fx.nativeElement.querySelector(sel);
      expect(el, 'no existe ' + sel).not.toBeNull();
      // ⚠️ jsdom no calcula layout, así que no se puede medir el alto. Lo que SÍ se puede exigir
      // es que el envoltorio no lleve ninguna de las clases que esconden.
      expect(el!.className, sel + ' usa una clase sr-only como envoltorio')
        .not.toMatch(/\bcg-cap\b/);
    }
  });

  it('la firma se pide en el GASTO y no en el ingreso ni en el depósito', async () => {
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();

    comp.setF('tipo', 'ingreso');
    fx.detectChanges();
    expect(comp.firmaPide()).toBe(false);
    expect(fx.nativeElement.querySelector('.cg-firma'), 'el ingreso no debería pedir firma').toBeNull();

    // ⚠️ El depósito también es efectivo que SALE y tampoco la pide: quien lo recibe es el banco,
    // y su respaldo es la ficha de depósito que Fase CC ya guarda con su OCR y su cuadre.
    comp.setF('tipo', 'deposito');
    fx.detectChanges();
    expect(comp.firmaPide()).toBe(false);

    comp.setF('tipo', 'gasto');
    fx.detectChanges();
    expect(comp.firmaPide()).toBe(true);
    expect(fx.nativeElement.querySelector('.cg-firma'), 'el gasto tiene que pedirla').not.toBeNull();
  });

  it('⛔ [negativa] sin firma el gasto SE GUARDA igual, y no manda un estado inventado', async () => {
    // El efectivo ya se movió. Una caja que no puede cerrar un movimiento por una firma es una
    // caja parada: se declara, no se frena (ADR-056).
    const crear = vi.fn(() => of({ id: 'x', folio: 'F-1' }));
    const fx = montar({ crear });
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });
    fx.detectChanges();
    expect(comp.bloqueos(), 'la firma NO puede ser un bloqueo').toEqual([]);

    comp.guardar();

    expect(crear).toHaveBeenCalledTimes(1);
    const cuerpo = crear.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo['firma_png'], 'sin firmar no se manda imagen').toBeUndefined();
    // ⭐⭐ Y lo que define que el servidor sea la autoridad: la pantalla NO manda el estado.
    // Si lo mandara, podría declarar «firmado» sin imagen — o sea firmar por otro.
    expect(cuerpo['firma_estado'], 'la pantalla mandó el veredicto: eso lo decide el servidor')
      .toBeUndefined();
  });

  // ── [CG.68] La firma desde el teléfono del mostrador ─────────────────────────────────────
  //
  // Edgar: *"si esto lo estoy usando en pc, ¿cómo hago que esto se envíe a mi teléfono para que
  // se firme?"*. La PC pide un código, el teléfono lo teclea, y el PNG vuelve por una room que
  // es de los dos — nunca por la del tenant, que tiene todas las cajas de la empresa adentro.

  it('⭐⭐ si el monto CAMBIA después de firmar, la firma deja de valer', async () => {
    // El agujero que esto tapa: el teléfono firma $1,900, el cajero agrega un billete, y la
    // pantalla seguiría diciendo «firmado» sobre $2,400. Una firma válida pegada a un número que
    // nadie aceptó. `firmaRemotaVale` es un computed y no una bandera porque el monto sale del
    // conteo: cambia con cada pieza, y nadie se va a acordar de revalidar a mano.
    const fx = montar();
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });                                  // $1,500
    fx.detectChanges();

    // Llega la firma del teléfono, hecha sobre lo que había en ese momento.
    comp.firmaRemotaPng.set('data:image/png;base64,AAA');
    comp.firmaRemotaMonto.set(1500);
    comp.firmaHecha.set(true);
    expect(comp.firmaRemotaVale()).toBe(true);

    // El cajero sigue contando.
    contar({ 500: 3, 200: 1 });                          // $1,700
    expect(comp.f().monto).toBe(1700);
    expect(comp.firmaRemotaVale(), 'la firma siguió valiendo sobre otra cifra').toBe(false);
  });

  it('⛔ [negativa] una firma que ya no vale NO se manda al servidor', async () => {
    // Lo anterior sin esto sería cosmético: el aviso en pantalla y el cuerpo del POST tienen que
    // decir lo mismo, o se guarda evidencia que la propia pantalla declaró inválida.
    const crear = vi.fn(() => of({ id: 'x', folio: 'F-1' }));
    const fx = montar({ crear });
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });
    comp.firmaRemotaPng.set('data:image/png;base64,AAA');
    comp.firmaRemotaMonto.set(999);                      // firmada sobre OTRO monto
    fx.detectChanges();

    comp.guardar();

    const cuerpo = crear.mock.calls[0][0] as Record<string, unknown>;
    expect(cuerpo['firma_png'], 'se mandó una firma que ya no correspondía').toBeUndefined();
  });

  /**
   * `[CG.81]` **Guardar NO manda el ticket a la térmica.** Pedido de Edgar: *"hay que dejar de
   * mandar el imprimible del ticket y sólo almacenarlo como un historial"*.
   *
   * ⚠️ Se mide el EFECTO, no la ausencia de una llamada: `imprimirComprobante` no se inyecta, se
   * importa, así que espiarla no probaría nada sobre lo que el navegador hace. Lo que define
   * "imprimió" es que el módulo crea un `<iframe>` oculto y lo cuelga del documento; eso sí se ve.
   *
   * Y la negativa va PEGADA a la positiva: una prueba que sólo exige "no imprime" también pasa si
   * la impresión se rompió entera — que es justo lo que NO queremos, porque el botón de la lista
   * es ahora el único camino al papel.
   */
  it('⛔ [CG.81] guardar NO imprime el comprobante — pero el botón de la lista SÍ', async () => {
    const crear = vi.fn(() => of({ id: 'x', folio: 'CG-2026-00009' }));
    const detalle = vi.fn(() => of({
      id: 'x', folio: 'CG-2026-00009', tipo: 'gasto', monto: 1500, glosa: 'compra de papeleria',
      denominaciones: [{ denominacion: 500, piezas: 3 }],
    }));
    const fx = montar({ crear, detalle });

    const marcos = () => document.querySelectorAll('iframe[aria-hidden="true"]').length;
    const antes = marcos();

    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });
    fx.detectChanges();

    comp.guardar();

    expect(crear, 'el movimiento tiene que guardarse igual').toHaveBeenCalledTimes(1);
    expect(marcos() - antes, 'guardar mandó el ticket a la térmica').toBe(0);
    expect(detalle, 'guardar no debe pedir el detalle para imprimir').not.toHaveBeenCalled();

    // La positiva: el camino al papel sigue existiendo, y es el de la lista.
    comp.imprimirComprobante({ id: 'x', folio: 'CG-2026-00009', estado: 'registrado' } as never);
    expect(detalle, 'el botón de la lista tiene que pedir el detalle guardado').toHaveBeenCalledTimes(1);
    expect(marcos() - antes, 'el botón de la lista ya no imprime nada').toBeGreaterThan(0);
  });

  /**
   * ⛔ `[CG.74]` La pantalla mandaba a un menú que NO EXISTE.
   *
   * Decía *«Abrí Caja General › Firmar en el teléfono»*. Medido: la ruta está registrada y **nada
   * en la navegación apunta ahí** — la única mención en el repo era un comentario. O sea: teclear
   * una URL de memoria, en un teléfono, con un código que vive tres minutos. Lo encontró Edgar
   * preguntando «¿cómo hago esto?».
   *
   * Las aserciones van contra el DOM: lo que falla acá es lo que la persona LEE y ESCANEA, y un
   * test sobre el método pasaría verde con el texto equivocado puesto.
   */
  /**
   * ⚠️ El pintado del QR es ASÍNCRONO desde que el codificador se carga diferido (el `import`
   * estático metía 449 kB en el paquete inicial y reventaba el presupuesto de `main`). Esperar
   * "un turno" no alcanza: hay que esperar a que baje el trozo. Se espera con techo, no para
   * siempre — si no aparece, la aserción de abajo falla con su mensaje, que es lo que se quiere.
   */
  async function esperarQr(fx: { detectChanges(): void; nativeElement: HTMLElement }): Promise<void> {
    for (let i = 0; i < 50; i++) {
      fx.detectChanges();
      if (fx.nativeElement.querySelector('.cg-firma-qr svg')) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    fx.detectChanges();
  }

  it('⭐ [CG.74] pedir el código pinta un QR, y el texto deja de mandar a un menú inexistente', async () => {
    const fx = montar();
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');          // la firma sólo se pide en el egreso
    fx.detectChanges();
    await comp.firmaPedirEnTelefono();
    await esperarQr(fx);

    const hueco = fx.nativeElement.querySelector('.cg-firma-qr') as HTMLElement | null;
    expect(hueco, 'no hay hueco para el QR').not.toBeNull();
    expect(hueco!.querySelector('svg'), 'el hueco quedó vacío: el QR no se pintó').not.toBeNull();

    const panel = (fx.nativeElement.querySelector('.cg-firma-codigo') as HTMLElement).textContent ?? '';
    expect(panel).toContain('ABC234');   // el código sigue a la vista
    // `[CG.84]` La ruta que se dicta pasó a `/firmar`, la PÚBLICA: la vieja colgaba de un padre
    // con `authGuard`, o sea que el teléfono necesitaba sesión para firmar un recibo.
    expect(panel).toContain('/firmar');
    expect(panel, 'sigue mandando a una entrada de menú que no existe')
      .not.toMatch(/Caja General\s*[›>]/);
  });

  it('⛔ [CG.74] [negativa] al cancelar, el QR vencido NO se queda en pantalla', async () => {
    // Un QR vencido es peor que ninguno: alguien lo escanea, el teléfono dice que el código no
    // existe, y queda buscando el error donde no está.
    const fx = montar();
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    fx.detectChanges();
    await comp.firmaPedirEnTelefono();
    await esperarQr(fx);
    expect(fx.nativeElement.querySelector('.cg-firma-qr svg')).not.toBeNull();

    comp.firmaCerrarRemota();
    fx.detectChanges();
    expect(fx.nativeElement.querySelector('.cg-firma-qr svg'),
      'quedó el QR del código que ya se cerró').toBeNull();
  });

  it('[CG.74] la ruta que se dicta no lleva el esquema: nadie dicta "https://"', () => {
    montar();
    expect(comp.rutaFirmaCorta()).toContain('/firmar');
    expect(comp.rutaFirmaCorta()).not.toContain('http');
  });

  it('⭐ [CG.84] el QR lleva el PASE: el teléfono entra sin iniciar sesión', async () => {
    // Sin el pase el teléfono cae en la ruta pública SIN credencial, el canal lo rechaza, y
    // volvemos al login que Edgar pidió quitar. Que el pase viaje en el QR ES la garantía.
    // ⚠️ El doble se pisa DESPUÉS de montar: el `over` de montar() va a `svc`, no al socket.
    const fx = montar();
    cajaSock.abrirFirma = vi.fn(async () => ({ ok: true, codigo: 'ABC234', pase: 'ey.PASE.firmado' }));
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    fx.detectChanges();
    await comp.firmaPedirEnTelefono();

    expect(comp.firmaPase(), 'el pase no se guardó').toBe('ey.PASE.firmado');
    const url = (comp as unknown as { urlFirmaTelefono(c: string): string }).urlFirmaTelefono('ABC234');
    expect(url).toContain('/firmar');
    expect(url).toContain('c=ABC234');               // el código sigue, para dictarlo
    expect(url).toContain('pase=ey.PASE.firmado');   // y el pase, para no pedir contraseña
  });

  it('⛔ [CG.84] [negativa] al cerrar el panel, el pase NO se queda vivo', async () => {
    // Un pase es una llave de 3 minutos. Si sobrevive al panel, el próximo QR sale firmado con
    // la llave de un movimiento que ya se cerró.
    const fx = montar();
    cajaSock.abrirFirma = vi.fn(async () => ({ ok: true, codigo: 'ABC234', pase: 'ey.PASE.firmado' }));
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    fx.detectChanges();
    await comp.firmaPedirEnTelefono();
    expect(comp.firmaPase()).toBe('ey.PASE.firmado');

    comp.firmaCerrarRemota();
    expect(comp.firmaPase(), 'el pase sobrevivió al panel que lo creó').toBeNull();
  });

  it('⛔ [CG.84] [negativa] si el servidor NO manda pase, el QR sale con el código solo', async () => {
    // Compatibilidad hacia atrás MEDIDA, no supuesta: con un backend viejo el camino de antes
    // (teléfono con sesión + código tecleado) tiene que seguir funcionando.
    const fx = montar();
    cajaSock.abrirFirma = vi.fn(async () => ({ ok: true, codigo: 'ABC234' }));
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    fx.detectChanges();
    await comp.firmaPedirEnTelefono();

    expect(comp.firmaPase()).toBeNull();
    const url = (comp as unknown as { urlFirmaTelefono(c: string): string }).urlFirmaTelefono('ABC234');
    expect(url).toContain('c=ABC234');
    expect(url).not.toContain('pase=');
  });

  it('el código del emparejamiento NO sobrevive a la captura anterior', async () => {
    // Un código viejo traería la firma de otro movimiento a esta captura.
    const fx = montar();
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    fx.detectChanges();
    comp.firmaCodigo.set('ABC234');
    comp.firmaRemotaPng.set('data:image/png;base64,AAA');
    comp.firmaRemotaMonto.set(1500);

    comp.abrirCaptura();

    expect(comp.firmaCodigo()).toBeNull();
    expect(comp.firmaRemotaPng()).toBeNull();
    expect(comp.firmaRemotaMonto()).toBeNull();
  });

  it('⛔ [negativa] la firma NO sobrevive al movimiento anterior', async () => {
    // Sin el reseteo, la firma de un gasto se guardaría en el SIGUIENTE: evidencia atribuida a
    // quien no firmó, y en silencio, porque el trazo ya dibujado se ve igual que uno nuevo.
    const fx = montar();
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    fx.detectChanges();

    comp.firmaHecha.set(true);
    comp.firmaNombre.set('Juan Pérez');

    comp.abrirCaptura();
    fx.detectChanges();

    expect(comp.firmaHecha(), 'la firma anterior siguió marcada').toBe(false);
    expect(comp.firmaNombre(), 'el nombre anterior siguió puesto').toBe('');
  });

  it('⛔ [regresión] cerrar y volver a tocar el MISMO movimiento lo vuelve a abrir', async () => {
    // El defecto exacto que reportó Edgar, aislado. `cobroElegido` no se limpia al cerrar —a
    // propósito, `guardar()` lo lee— y `filaEnCaptura` lo ignoraba, así que la fila seguía
    // contando como seleccionada para `p-table`. Con `metaKeySelection=false`, tocar una fila ya
    // seleccionada la DESELECCIONA: emitía `null`, y el guarda de «no cerrar con null» convertía
    // eso en silencio absoluto.
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const fila = (): HTMLElement => fx.nativeElement.querySelector('.cg-bandeja-tbl tbody tr');
    fila().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fx.detectChanges();
    expect(comp.capturaAbierta()).toBe(true);

    comp.cerrarConFoco(comp.capturaAbierta);
    fx.detectChanges();
    // ⭐ La proyección tiene que soltar la fila: no puede haber una fila EN CAPTURA sin captura.
    expect(comp.filaEnCaptura(), 'la fila quedó seleccionada con la captura cerrada').toBeNull();

    fila().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fx.detectChanges();
    expect(comp.capturaAbierta(), 'el segundo clic en la misma fila no abrió').toBe(true);
    expect(comp.cobroElegido()?.origen_ref).toBe(FILA_A.origen_ref);
  });

  it('abrir desde la cola marca la fila como ABIERTA, que no es lo mismo que marcada', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    comp.abrirDeLaCola(FILA_A);
    fx.detectChanges();

    const filas = Array.from(
      fx.nativeElement.querySelectorAll('.cg-bandeja-tbl tbody tr'),
    ) as HTMLElement[];
    const abierta = filas.filter((f) => f.classList.contains('cg-fila-abierta'));
    expect(abierta.length, 'una y sólo una fila abierta').toBe(1);

    // ⚠️ ABIERTA y MARCADA son dos hechos distintos y no se pueden pintar igual: una es «en esto
    // estoy trabajando», la otra «esto entra al lote». Abrir no marca.
    expect(abierta[0].classList.contains('cg-fila-marcada')).toBe(false);
    expect(comp.marcadas()).toEqual([]);
  });

  // ── [CG.62] Guardar baja al pie del arqueo, y pregunta antes ──────────────────────────────
  //
  // Edgar: *"el botón de guardar se debe mostrar abajo de arqueo, para solo pasar del arqueo a
  // guardar"* + *"una ventana de «seguro que querés guardar»"*.

  it('Guardar vive al pie del ARQUEO y DESPUÉS de la reja: la flecha llega a él', async () => {
    const fx = montar();
    comp.abrirCaptura();
    // ⚠️ Con bloqueos el botón está DESHABILITADO, y `moverFoco` lo salta a propósito: no se
    // puede caer con una flecha en un control que no se puede apretar. Así que la prueba llega
    // al estado guardable de verdad — si no, mediría el caso en el que el salto no debe ocurrir.
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });
    expect(comp.bloqueos()).toEqual([]);
    await Promise.resolve();
    fx.detectChanges();

    const boton: HTMLElement = fx.nativeElement.querySelector('button.cg-guardar');
    expect(boton, 'no hay botón de guardar').not.toBeNull();
    expect(boton.closest('.cg-ap-arqueo'), 'Guardar no está en el apartado del arqueo').not.toBeNull();

    // ⭐ Y el ORDEN importa, no es cosmético: `moverFoco` recorre el DOM con `querySelectorAll`,
    // así que si el botón quedara ANTES de la reja la flecha hacia abajo saltaría hacia atrás.
    const ultima: HTMLElement = Array.from(
      fx.nativeElement.querySelectorAll('input.cg-pieza'),
    ).pop() as HTMLElement;
    expect(ultima, 'no hay campos de pieza').toBeTruthy();
    expect(ultima.compareDocumentPosition(boton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // La cadena de la flecha los incluye a los dos: del último campo contado, al botón.
    const cadena = Array.from(
      fx.nativeElement.querySelectorAll('input.cg-pieza, button.cg-guardar'),
    );
    expect(cadena[cadena.length - 1]).toBe(boton);

    // ⭐ Y se EJERCE, no se infiere del DOM: la flecha desde el último campo contado tiene que
    // dejar el foco en Guardar. `moverFoco` llamaba `.select()` sin preguntar, y un botón no lo
    // tiene — el defecto habría reventado justo acá, en la última flecha del arqueo.
    ultima.focus();
    comp.moverEnReja({ target: ultima, preventDefault: () => undefined } as unknown as Event, 1);
    expect(document.activeElement, 'la flecha no llegó a Guardar').toBe(boton);

    // Y vuelve: quien baja de más no queda atrapado en el botón.
    comp.moverEnReja({ target: boton, preventDefault: () => undefined } as unknown as Event, -1);
    expect(document.activeElement).toBe(ultima);
  });

  it('⭐ el atajo se ANUNCIA: en el campo y escrito en la cabecera', async () => {
    // D.5 lo exige y nada lo hacía cumplir: *"un atajo que nadie sabe que existe no existe"*.
    // Medido antes de tocar nada: CERO `aria-keyshortcuts` en esta pantalla, y UNO en todo el
    // repo. Las flechas del arqueo llevaban varios commits funcionando en silencio — y Edgar
    // reportó «no me puedo mover con las flechas» sobre la única parte donde sí se podía.
    const fx = montar();
    comp.abrirCaptura();
    await Promise.resolve();
    fx.detectChanges();

    const campos = Array.from(
      fx.nativeElement.querySelectorAll('input.cg-pieza'),
    ) as HTMLElement[];
    expect(campos.length, 'no hay campos de pieza').toBeGreaterThan(0);
    for (const c of campos) {
      expect(c.getAttribute('aria-keyshortcuts'), 'un campo de la reja no anuncia su atajo')
        .toContain('ArrowDown');
    }

    // Y en pantalla, no sólo para el lector: la cabecera del arqueo lo dice.
    const cab: HTMLElement = fx.nativeElement.querySelector('.cg-ap-arqueo .cg-ap-head');
    expect(cab.textContent, 'la cabecera del arqueo no escribe el atajo').toContain('Guardar');
    expect(cab.querySelectorAll('kbd').length).toBeGreaterThan(0);
  });

  it('⛔ [negativa] con el formulario incompleto la flecha NO cae en Guardar', async () => {
    // Un foco que aterriza en un botón apagado es un callejón: el teclado llega y no puede hacer
    // nada, y volver exige el mouse. `moverFoco` salta lo deshabilitado; esto lo congela.
    const fx = montar();
    comp.abrirCaptura();
    contar({ 500: 3 });                 // hay algo contado, pero falta la clasificación
    await Promise.resolve();
    fx.detectChanges();
    expect(comp.bloqueos().length, 'el formulario tendría que seguir bloqueado').toBeGreaterThan(0);

    const ultima: HTMLElement = Array.from(
      fx.nativeElement.querySelectorAll('input.cg-pieza'),
    ).pop() as HTMLElement;
    ultima.focus();
    comp.moverEnReja({ target: ultima, preventDefault: () => undefined } as unknown as Event, 1);
    expect(document.activeElement, 'la flecha cayó en un botón apagado').toBe(ultima);
  });

  it('⛔ [negativa] Guardar NO guarda: abre la pregunta, y la pregunta DICE el veredicto', () => {
    const crear = vi.fn(() => of({ id: 'x', folio: 'F-1' }));
    const fx = montar({ crear });
    comp.abrirCaptura();
    // ⚠️ Se llega al estado GUARDABLE de verdad, no se finge: con bloqueos el botón está apagado
    // y `pedirConfirmacion` sale sin hacer nada — una prueba que no los limpiara pasaría por la
    // rama equivocada y diría «no guardó» sobre un botón que ni se podía apretar.
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 3 });
    expect(comp.bloqueos()).toEqual([]);
    fx.detectChanges();

    // ⭐ Se APRIETA EL BOTÓN, no se llama al método. La primera versión de esta prueba invocaba
    // `pedirConfirmacion()` directo, y mutar el template a `(onClick)="guardar()"` la dejaba
    // VERDE: medía una función que nadie garantizaba que estuviera cableada. El candado tiene
    // que entrar por donde entra la persona.
    const boton: HTMLElement = fx.nativeElement.querySelector('button.cg-guardar');
    expect(boton, 'no hay botón de guardar').not.toBeNull();
    boton.click();
    fx.detectChanges();

    // ⛔ Lo que define que sea una guarda y no un trámite: todavía NO se guardó nada.
    expect(crear, 'Guardar escribió sin preguntar').not.toHaveBeenCalled();
    expect(comp.confirmarGuardar()).toBe(true);

    // ⚠️ Y que la ventana DIGA qué va a pasar. Un "¿estás seguro?" mudo es un clic de peaje que
    // se aprende a tirar sin leer: estorba sin proteger. Tiene que repetir el veredicto del
    // arqueo, que es lo único que no se puede deshacer después.
    const conf: HTMLElement = fx.nativeElement.querySelector('.cg-conf');
    expect(conf, 'la ventana no se pintó').not.toBeNull();
    expect(conf.textContent).toContain(comp.textoVeredicto(comp.arqueoVeredicto()));

    // Y recién al confirmar se escribe.
    comp.guardar();
    expect(crear).toHaveBeenCalledTimes(1);
    expect(comp.confirmarGuardar(), 'la ventana quedó abierta tapando el aviso').toBe(false);
  });

  it('⭐ pero marcar SIGUE siendo posible y se VE: sin esto, limpiar dejaría la bandeja muerta', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const fila = () => fx.nativeElement.querySelector('.cg-bandeja-tbl tbody tr') as HTMLElement;
    expect(fila().classList.contains('cg-fila-marcada')).toBe(false);

    comp.marcar(FILA_A.origen_ref, true);
    fx.detectChanges();

    // El estado se ve: la fila cambia de clase y aparece su marca.
    expect(fila().classList.contains('cg-fila-marcada')).toBe(true);
    expect(fila().querySelector('.cg-td-marca i')).not.toBeNull();
    expect(comp.marcadas()).toEqual([FILA_A.origen_ref]);
  });

  it('«Marcar las N» reemplaza a la casilla del encabezado, y DICE cuántas son', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    // La casilla de "marcar todas" nunca pudo decir cuántas eran; el botón sí.
    expect(fx.nativeElement.textContent).toContain('Marcar las 2');
    comp.marcarTodas(true);
    expect(comp.marcadas().length).toBe(2);
    fx.detectChanges();
    expect(fx.nativeElement.textContent).toContain('Quitar la marca');
  });

  it('[negativa] el lote manda SÓLO la referencia: ningún importe propio viaja al libro', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    const libre = comp.pendientes().find((p) => p.confirmable);
    expect(libre).toBeDefined();
    comp.marcar(libre!.origen_ref, true);
    comp.confirmarLote();

    expect(svc['confirmarLote']).toHaveBeenCalledTimes(1);
    const items = (svc['confirmarLote'] as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as
      Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]['origen_ref']).toBe(libre!.origen_ref);
    // La clave del asunto: el lote espeja al ERP. Si esto vuelve a viajar, vuelve el agujero.
    expect(items[0]).not.toHaveProperty('monto_contado');
    expect(Object.keys(items[0])).toEqual(['origen_ref']);
  });

  it('«Capturar» abre el diálogo ANCLADO al documento, y el importe NACE EN CERO', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);

    expect(comp.capturaAbierta()).toBe(true);
    expect(comp.cobroElegido()?.origen_ref).toBe(GASTO_TRABADO.origen_ref);
    expect(comp.f().tipo).toBe('gasto');
    expect(comp.f().sucursal).toBe('00');

    // CG.23 — Esta prueba decía "y con lo contado puesto" (monto 1100). Ahora el monto SALE del
    // desglose, y antes de contar el desglose está vacío: heredar una cifra que nadie contó es
    // exactamente lo que el arqueo obligatorio elimina.
    expect(comp.f().monto).toBe(0);
    expect(comp.montoContado()).toBe(null);
    expect(comp.bloqueos()).toContain('falta_desglose');
  });

  it('⛔⛔ [CG.111] con documento anclado, el selector EXCLUYENTE de CAOS no se ofrece', () => {
    // Ese campo llama a `tomarMovimientoCaos`, que hace `cobroElegido.set(null)`. Estaba visible
    // también con un documento ya elegido, así que usarlo ahí BORRABA el documento en silencio:
    // se iban fecha, sucursal, beneficiario y la cuenta de la póliza, y `origen_tipo` pasaba de
    // `pago_proveedor` a `caos`. Medido en prod: 11 de 30 movimientos quedaron con origen `caos`.
    // Edgar: "a lo mucho enlazarlo con un movimiento de caos" — enlazar, no reemplazar.
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    fx.detectChanges();

    expect(comp.cobroElegido()?.origen_ref, 'el documento tiene que estar anclado')
      .toBe(GASTO_TRABADO.origen_ref);
    expect(fx.nativeElement.querySelector('#cg-caos'),
      'el selector que BORRA el documento sigue a la vista').toBeNull();
  });

  it('⭐ [CG.111] [negativa] SIN documento, el selector de CAOS SÍ se ofrece', () => {
    // La prueba negativa del candado: si se ocultara siempre, la captura manual desde la caja
    // fuerte —que es un camino legítimo y el único para un movimiento sin documento— quedaría
    // sin entrada. Ocultar de más es tan defecto como ocultar de menos.
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();

    expect(comp.cobroElegido()).toBeNull();
    expect(fx.nativeElement.querySelector('#cg-caos'),
      'sin documento el selector de CAOS tiene que estar').not.toBeNull();
  });

  it('⛔⛔ [CG.114] la reja arranca VACÍA, no en cero — si no, teclear 1 deja 10', () => {
    // Edgar: "otro error típico de pendejos es poner un 0 por default en una caja, si yo pongo 1
    // se escribe 10". Es literal: con un 0 ya tecleado, escribir 1 deja 10. En una reja de arqueo
    // eso es un billete de más por renglón, en el campo del que SALE el monto del movimiento.
    //
    // Y es el mismo defecto que ADR-056 nombra, movido al formulario: dibujar un cero donde no
    // hubo medición. "No conté este renglón" y "conté y había cero" son hechos distintos.
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    fx.detectChanges();

    const b500 = DENOMINACIONES_MXN.find((d) => d.key === '500')!;
    expect(comp.piezasDe(b500), 'la caja nace con un cero tecleado adentro').toBeNull();
    expect(comp.piezasDevueltasDe(b500)).toBeNull();
    expect(comp.morrallaVista(), 'la morralla también').toBeNull();

    // Y en cuanto se cuenta, muestra lo contado: vacía no es "siempre vacía".
    comp.setPiezas(b500, 3);
    expect(comp.piezasDe(b500)).toBe(3);
    expect(comp.subtotalDe(b500)).toBe(1500);
  });

  it('⛔ [CG.114] [negativa] un cero CONTADO no se guarda como renglón, y la caja queda vacía', () => {
    // La otra mitad: si alguien teclea 0 a propósito, no hay nada que guardar — cero piezas de
    // $500 no es un renglón del arqueo. La caja vuelve a vacía, que es lo que de verdad hay.
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    fx.detectChanges();

    const b500 = DENOMINACIONES_MXN.find((d) => d.key === '500')!;
    comp.setPiezas(b500, 3);
    comp.setPiezas(b500, 0);
    expect(comp.piezasDe(b500)).toBeNull();
    expect(comp.f().denominaciones.some((d) => d.denom_key === '500'),
      'guardó un renglón de cero piezas').toBe(false);
  });

  it('sin conteo, el importe NO lo hereda del documento: hay que contar', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    // Antes esto esperaba 1060 (el importe del ERP). Dar por bueno el importe del documento
    // vuelve el arqueo un trámite: se guardaba la cifra de Kepler sin haber contado nada.
    expect(comp.f().monto).toBe(0);
    expect(comp.montoContado()).toBe(null);
  });

  it('contar distinto del documento ES un arqueo; contar lo mismo deja de serlo', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);     // el documento dice 1060

    contar({ 500: 2, 100: 1 });            // 1100
    expect(comp.f().monto).toBe(1100);
    expect(comp.montoContado()).toBe(1100);

    contar({ 500: 2, 100: 0, 50: 1, 20: 0 });
    comp.setMorralla(10);                  // 1000 + 50 + 10 = 1060, el mismo del documento
    expect(comp.f().monto).toBe(1060);
    expect(comp.montoContado()).toBe(null);
  });

  it('guardar manda monto_contado y el origen_tipo del DOCUMENTO, no "cobro" clavado', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'gasto de caja chica');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 2, 100: 1 });        // 1100, contra un documento que dice 1060

    // ⚠️ `GASTO_TRABADO` es el documento REAL que salió mal en prod (`X-D-26 0001298`, fechado
    // 2026-12-10 por un error de captura de Kepler), así que el freno nuevo lo detiene. Corregir la
    // fecha es exactamente lo que ahora tiene que hacer el capturista, y el campo es editable.
    expect(comp.bloqueos()).toEqual(['fecha_futura']);
    comp.setF('fecha', todayMx());

    expect(comp.bloqueos()).toEqual([]);
    comp.guardar();

    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // Un X-D-26 guardado como 'cobro' es un origen mal etiquetado.
    expect(body['origen_tipo']).toBe('pago_proveedor');
    expect(body['origen_ref']).toBe(GASTO_TRABADO.origen_ref);
    // Sin esto el servidor relee el importe del ERP y lo contado no llega al libro.
    expect(body['monto_contado']).toBe(1100);
  });

  /**
   * CG — ⛔ El freno de la fecha futura, en el caso que lo hizo falta.
   *
   * `GASTO_TRABADO` no es un fixture inventado: es `00|X-D-26|0001298|0011`, el documento que el
   * 2026-09-28 entró al libro de producción como `CG-2026-00002` con `fecha = 2026-12-10`. Es un
   * gasto de ENERO ("GASTOS NF MORELIA 28-01-2026") que Kepler fechó en diciembre. La bandeja ya
   * lo rotulaba desde el 22-sep y el rótulo no frenaba: el libro terminó mostrando 1 de 2
   * movimientos, porque el filtro por default va del 1º del mes a hoy.
   */
  it('⛔ [negativa] no deja guardar un documento fechado adelante de hoy', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'gasto de caja chica');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 2, 100: 1 });

    expect(comp.f().fecha).toBe('2026-12-10');   // la fecha llega del documento, como siempre
    expect(comp.bloqueos()).toContain('fecha_futura');
    comp.guardar();
    // Lo que importa no es el aviso: es que NO se mandó nada al servidor.
    expect(svc['crear']).not.toHaveBeenCalled();
  });

  // ── 9 · PERSISTENCIA: lo marcado sobrevive a un F5 ───────────────────────────────────────
  //
  // Punto 2 de la revisión de Edgar. Medido antes: la pantalla NO persistía nada — `contado` y
  // `seleccion` eran señales en memoria, así que un refresh borraba todo. Con hasta 100 filas
  // por pantalla y 12,207 pendientes, eso es mucho trabajo tirado por una tecla.
  //
  // ⚠️ `[CG.48]` Nació persistiendo DOS cosas; hoy el conteo por renglón no existe, así que lo
  // que la red protege es la SELECCIÓN. Marcar 40 filas y perderlas en un F5 sigue doliendo.

  it('lo marcado sobrevive a remontar la pantalla', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    comp.marcar(FILA_A.origen_ref, true);

    // Se tira el componente y se vuelve a entrar, como un F5.
    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });

    expect(comp.marcadas()).toEqual([FILA_A.origen_ref]);
    expect(comp.restaurado()?.marcadas).toBe(1);
  });

  it('NO revive una marca cuya fila ya no está pendiente — y lo dice', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    comp.marcar(FILA_A.origen_ref, true);

    // Otra persona lo confirmó: al volver, esa fila ya no está en la bandeja.
    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(VACIA)) });

    expect(comp.marcadas()).toEqual([]);
    expect(comp.restaurado()?.descartados).toBe(1);
  });

  it('un borrador VIEJO con conteos por renglón no los revive, y lo DICE', () => {
    // El estado real de cualquiera que tuviera la pantalla abierta cuando se retiró la columna.
    localStorage.setItem('caja.borrador.u1', JSON.stringify({
      usuario: 'u1', guardadoEn: Date.now(),
      contado: [[FILA_A.origen_ref, 1100]], marcadas: [FILA_B.origen_ref],
    }));
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });

    // La marca se recupera; el conteo NO — no hay dónde ponerlo y no lleva desglose.
    expect(comp.marcadas()).toEqual([FILA_B.origen_ref]);
    const r = comp.restaurado();
    expect(r?.conteosViejos).toBe(1);
    // Y se dice, en vez de desaparecer en silencio: la persona SÍ tecleó eso.
    expect(comp.textoRestaurado(r!)).toContain('esa columna se retiró');
  });

  it('la clave lleva el USUARIO: en un navegador compartido no se cruza el trabajo', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    comp.marcar(FILA_A.origen_ref, true);

    // Entra otro cajero en el MISMO navegador.
    TestBed.resetTestingModule();
    svc = {
      cobertura: vi.fn(() => of(COBERTURA)), libro: vi.fn(() => of(LIBRO)), saldo: vi.fn(() => of(SALDO)),
      cortes: vi.fn(() => of({ rows: [] })), cajas: vi.fn(() => of({ rows: CAJAS, ventana_dias: 1 })),
      movimientosPendientes: vi.fn(() => of(CON_GASTO)), frecuentes: vi.fn(() => of({ rows: [FRECUENTE] })),
      caosCapturables: vi.fn(() => of({ rows: [], limit: 100, has_more: false, desde: '2026-09-21' })),
      autofill: vi.fn(() => of({ concepto: null, provenance: null })), conceptos: vi.fn(() => of({ rows: [] })),
      crear: vi.fn(() => of({ id: 'm1' })),
      confirmarLote: vi.fn(() => of({ filas: [], guardados: 0, duplicados: 0, rechazados: 0, no_confirmables: 0, monto_guardado: 0 })),
      // [CG.26] Este mock se arma a mano (no sale de `montar`), así que todo lo que `ngOnInit`
      // toque tiene que estar acá o el montaje revienta con "is not a function".
      arqueoDia: vi.fn(() => of(ARQUEO)),
      recurrentesSinRegla: vi.fn(() => of(RECURRENTES)),
      jornadasPendientes: vi.fn(() => of({ sucursal: '00', hoy: todayMx(), inicio_libro: null, jornadas: [], alcance: 'cajon' })),
      // `[CGS.14]` Por omisión la caja está libre: las pruebas del candado lo sobrescriben.
      candado: vi.fn(() => of({ bloqueado: false, motivo: null, jornada: null, texto: null, con_llave: null, activo: true, hoy: todayMx(), pueden_recibir_llave: [] })),
    };
    TestBed.configureTestingModule({
      imports: [FinanzasCajaGeneralComponent],
      providers: [
        provideZonelessChangeDetection(), provideRouter([]),
        { provide: CashLedgerService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ sub: 'OTRO-CAJERO' }) } },
      ],
    });
    const f2 = TestBed.createComponent(FinanzasCajaGeneralComponent);
    f2.detectChanges();

    // Trabajo ajeno firmado con tu nombre no es un bug de comodidad.
    expect(f2.componentInstance.marcadas()).toEqual([]);
    expect(f2.componentInstance.restaurado()).toBe(null);
  });

  it('confirmar el lote retira el borrador (ya está en el libro)', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    comp.marcar(FILA_A.origen_ref, true);
    comp.confirmarLote();

    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    expect(comp.marcadas()).toEqual([]);
  });

  it('un localStorage que revienta NO tumba la bandeja', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceeded'); };
    try {
      montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
      // El borrador es una red, no una dependencia: marcar tiene que seguir funcionando.
      expect(() => comp.marcar(FILA_A.origen_ref, true)).not.toThrow();
      expect(comp.marcadas()).toEqual([FILA_A.origen_ref]);
    } finally {
      Storage.prototype.setItem = real;
    }
  });

  it('descartar el borrador deja la bandeja limpia', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    comp.marcar(FILA_A.origen_ref, true);
    comp.descartarBorrador();
    expect(comp.marcadas()).toEqual([]);

    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    expect(comp.marcadas()).toEqual([]);
  });

  // ── 10 · TECLADO: contar es recorrer una columna ─────────────────────────────────────────
  //
  // Punto 3 de la revisión. Medido antes: el archivo no tenía UN SOLO manejo de foco (0 `focus()`,
  // 0 `keydown`). Con el Tab pelado cada renglón son varios saltos, con el efectivo en la mano.
  //
  // ⚠️ `[CG.48]` Esto se estrenó sobre la columna "Contado" de la bandeja, que ya no existe. La
  // conducta NO cambió de significado — cambió de superficie: la columna que se recorre tecleando
  // es la REJA del arqueo, que es donde de verdad se cuenta pieza por pieza.

  const inputsReja = (fx: { nativeElement: HTMLElement }) =>
    Array.from(fx.nativeElement.querySelectorAll('input.cg-pieza')) as HTMLInputElement[];

  /** Abre la captura y devuelve los inputs de la reja, ya renderizados. */
  const abrirReja = async (fx: { nativeElement: HTMLElement; detectChanges(): void }) => {
    comp.abrirCaptura();
    await Promise.resolve();
    fx.detectChanges();
    return inputsReja(fx);
  };

  it('Enter en una denominación baja a la siguiente de la columna', async () => {
    const fx = montar();
    const ins = await abrirReja(fx);
    // Cinco billetes + seis monedas + morralla: la reja real de la caja.
    expect(ins.length).toBeGreaterThan(2);
    ins[0].focus();
    ins[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(document.activeElement).toBe(ins[1]);
  });

  it('la flecha arriba vuelve a la anterior — y NO incrementa las piezas', async () => {
    const fx = montar();
    const ins = await abrirReja(fx);
    ins[1].focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    ins[1].dispatchEvent(ev);

    expect(document.activeElement).toBe(ins[0]);
    // En un input numérico la flecha SUBE el valor de a uno. En un arqueo eso es dinero que
    // aparece solo, así que cancelar el default es parte del arreglo, no un efecto colateral.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('en el último renglón, Enter no rompe nada', async () => {
    const fx = montar();
    const ins = await abrirReja(fx);
    const ultimo = ins[ins.length - 1];
    ultimo.focus();
    expect(() => ultimo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))).not.toThrow();
    expect(document.activeElement).toBe(ultimo);
  });

  // ── [CG.49] El arqueo primero: la tarea no va al final de su propio formulario ────────────
  //
  // Reportado por Edgar sobre la pantalla en vivo: *"tengo que hacer scroll para ver todo el
  // contenido, al menos el importante que es el arqueo"*.
  //
  // ⛔ La causa fue una REGRESIÓN de `[CG.46]`, y no la ve ningún gate: las dos columnas del panel
  // existen desde CS.3.7 *"para que TODO entre en una pantalla sin scroll"*, pero al mudar la
  // captura de un `p-dialog` ancho a un `aside` que `.cg-split` dimensiona en **32rem**, el
  // `@container (max-width:46rem)` las colapsa **siempre** — la condición de dos columnas no se
  // puede cumplir ahí. Apilado manda el orden del DOM, y en el DOM el arqueo venía último.

  // ⭐ [CG.60] La afirmación SUBE de grado. Antes decía «el arqueo va antes que la clasificación
  // EN EL DOM», que era lo único que se podía exigir mientras los dos vivían apilados dentro del
  // mismo panel: una regla de orden, que un `@container` mal apuntado podía desarmar — y lo hizo
  // dos veces. Ahora no comparten caja: el arqueo es un APARTADO, con media pantalla reservada.
  // Un apartado no puede quedar «detrás» del otro, así que esto ya no se prueba con posiciones.

  it('el arqueo y la clasificación viven en APARTADOS distintos: ninguno puede tapar al otro', async () => {
    const fx = montar();
    comp.abrirCaptura();
    await Promise.resolve();
    fx.detectChanges();

    const reja: Element | null = fx.nativeElement.querySelector('.cg-arqueo-tbl');
    const glosa: Element | null = fx.nativeElement.querySelector('#cg-glosa');
    expect(reja).not.toBeNull();
    expect(glosa).not.toBeNull();

    expect(reja!.closest('.cg-ap-arqueo'), 'la reja vive en el apartado 2').not.toBeNull();
    expect(glosa!.closest('.cg-ap-que'), 'la glosa vive en el apartado 1').not.toBeNull();
    // Y son DOS cajas, no una con dos nombres: si alguien vuelve a meterlos en el mismo apartado,
    // vuelve la pelea por el alto que [CG.49] tuvo que arbitrar con el orden del DOM.
    expect(reja!.closest('.cg-ap')).not.toBe(glosa!.closest('.cg-ap'));
  });

  // ── [CG.50] D.7: las tablas se RECORREN con las flechas ──────────────────────────────────
  //
  // Edgar: *"necesito que toda la interfaz se pueda usar con las flechas del teclado"*.
  // Medido antes de tocar nada: **9 tablas en esta pantalla, 0 con `pSelectableRow`**. Con 100
  // filas de bandeja el teclado sólo podía tabular (casilla → Abrir → casilla → …) = 200 paradas.
  //
  // ⚠️ El primitivo NO se diseña: DESIGN D.7 es explícito en que `pSelectableRow` de PrimeNG ya
  // da ↑↓, Home/End, Enter/Space y **roving tabindex**, y que escribir una directiva propia para
  // una tabla es un antipatrón. Lo que se prueba acá es que esté PUESTO.

  it('las filas de la bandeja existen para el teclado: roving tabindex, no 200 paradas', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    // ⚠️ El selector va ACOTADO a la bandeja: la pantalla tiene 8 tablas y un `tbody tr` pelado
    // devuelve las filas del libro y de los cortes también. La prueba lo encontró sola.
    const filas = () =>
      Array.from(fx.nativeElement.querySelectorAll('.cg-bandeja-tbl tbody tr')) as HTMLElement[];
    expect(filas().length).toBe(2);

    // Lo que esto afirma: las filas EXISTEN para el teclado. Antes no tenían `tabindex` y no se
    // llegaba a ellas ni tabulando ni con flechas.
    for (const tr of filas()) expect(tr.getAttribute('tabindex')).not.toBeNull();
    expect(filas().every((tr) => tr.hasAttribute('data-p-selectable-row'))).toBe(true);

    // ⛔ Y lo que NO es cierto, medido en el fuente de PrimeNG 22 (`setRowTabIndex`): el roving
    // **no arranca encendido**. Mientras `anchorRowIndex` sea null, TODAS las filas devuelven 0
    // — o sea N paradas de tabulador, justo lo que D.4a quiere evitar. Empieza a rotar recién
    // cuando hay una fila ancla. DESIGN D.7 dice "el tabindex ya es roving" a secas: es media
    // verdad, y acá queda medida en vez de repetida.
    expect(filas().filter((tr) => tr.getAttribute('tabindex') === '0').length).toBe(2);

    comp.marcar(FILA_A.origen_ref, true);
    fx.detectChanges();
    const conAncla = filas().filter((tr) => tr.getAttribute('tabindex') === '0').length;
    expect(conAncla).toBeLessThanOrEqual(2);
  });

  // ⚠️ `[CG.54]` puso un rótulo visible «Confirmar» en el encabezado de la columna de casillas,
  // porque el control no decía qué hacía. `[CG.56]` retiró la columna entera: el rótulo que había
  // que arreglar dejó de existir, y la acción se nombra donde ahora vive — la barra, que además
  // dice CUÁNTAS son, que es lo que la casilla nunca pudo decir. Lo cubre la prueba de «Marcar
  // las N»; acá queda la nota para que nadie reponga un encabezado de una columna que ya no es.

  it('⛔ [negativa] marcar NO mete una fila sin cuenta declarada (el servidor la rechazaría)', () => {
    // ⭐ [CG.63] Este freno vivía en `onSeleccionTabla`, el callback de la tabla — o sea atado a
    // UN dispositivo de entrada. Al pasar el clic de marcar a abrir, ese callback desapareció y
    // el freno se habría ido con él SIN QUE NADA SE PUSIERA ROJO: `marcarTodas` filtra por su
    // cuenta, así que la suite seguía verde con el agujero abierto en el camino de a una.
    // Ahora se le pregunta al método que marca, que es donde el invariante pertenece.
    // ⚠️ La cola trae las DOS: la trabada y una confirmable. Con sólo la trabada, el freno y un
    // «marcar nunca marca nada» se verían idénticos — y un control de placebo se vuelve a pasar.
    montar({
      movimientosPendientes: vi.fn(() => of({
        ...CON_DOS, rows: [GASTO_TRABADO, FILA_A], confirmables: 1,
      })),
    });
    comp.marcar(GASTO_TRABADO.origen_ref, true);
    expect(comp.marcadas()).toEqual([]);

    // Y la positiva, para que el freno no sea «nunca marca nada»: la confirmable sí entra.
    comp.marcar(FILA_A.origen_ref, true);
    expect(comp.marcadas()).toEqual([FILA_A.origen_ref]);
  });

  it('la selección de la tabla y la señal son UNA sola verdad, en los dos sentidos', () => {
    // ⭐ [CG.63] Lo que la tabla selecciona cambió de significado — era «marcado para el lote» y
    // ahora es «el movimiento en el que estoy trabajando» — pero la regla NO cambió: PrimeNG
    // entra como dispositivo de entrada, nunca como segundo dueño del dato.
    montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });

    // De la tabla a la señal: seleccionar una fila ABRE ese movimiento.
    comp.abrirDeLaCola(FILA_A);
    expect(comp.capturaAbierta()).toBe(true);
    expect(comp.cobroElegido()?.origen_ref).toBe(FILA_A.origen_ref);

    // Y de la señal a la tabla: `filaEnCaptura` es una proyección de `cobroElegido`, no un
    // segundo estado que haya que mantener sincronizado a mano.
    expect(comp.filaEnCaptura()?.origen_ref).toBe(FILA_A.origen_ref);

    comp.abrirDeLaCola(FILA_B);
    expect(comp.filaEnCaptura()?.origen_ref).toBe(FILA_B.origen_ref);

    // ⛔ Y volver a tocar la fila abierta emite null: eso NO cierra la captura. Cerrar es una
    // acción propia (Cancelar), no el efecto de tocar dos veces lo mismo.
    comp.abrirDeLaCola(null);
    expect(comp.capturaAbierta()).toBe(true);
    expect(comp.filaEnCaptura()?.origen_ref).toBe(FILA_B.origen_ref);
  });

  // ── [CG.52] El movimiento entra ENTERO: el ancho sigue a la tarea ─────────────────────────
  //
  // Edgar: *"para ver el movimiento completo tengo que hacer scroll, este es un antipatrón"*.
  // `[CG.49]` había puesto el arqueo arriba pero NO devuelto el ancho: el panel medía 32rem fijo,
  // o sea un contenedor de ~486px contra un umbral de 736px — la condición para mostrar las dos
  // columnas era **inalcanzable por construcción**, y por eso el formulario se apilaba.

  // ⭐⭐ ESTA PRUEBA SE DA VUELTA POR SEGUNDA VEZ, 2026-10-16. Lo que cambió es el REQUISITO,
  // no el código, así que se reescribe entera en vez de aflojarle un número.
  //
  // Historia, porque importa para no volver atrás:
  //   `[CG.49]` el umbral de dos columnas era INALCANZABLE por construcción (486px vs 736px).
  //   `[CG.57]` la consulta medía el panel en vez de la columna.
  //   `[CG.60]` respondió clavando DOS MITADES FIJAS: «una condición que no existe no se puede
  //             romper». Correcto entonces.
  //
  // Edgar, 2026-10-16: *"necesito que el paso uno ocupe toda la pantalla"*. El reparto vuelve a
  // ser condicional — pero la condición ya NO es un ancho medido, que es lo que fallaba las dos
  // veces: es `capturaAbierta()`, un signal que el componente declara y del que no hay nada que
  // medir. Y lo que `[CG.60]` protegía se cumple mejor: cuando el arqueo aparece toma su mitad
  // entera, y cuando no hay nada que contar no le roba media pantalla a la cola.

  it('⭐ la lista ocupa la pantalla SIEMPRE: una sola columna, pase lo que pase', () => {
    const fx = montar();
    const split: HTMLElement = fx.nativeElement.querySelector('.cg-split');
    expect(split.querySelectorAll(':scope > .cg-ap').length, 'un solo apartado en el flujo').toBe(1);

    comp.abrirCaptura();
    fx.detectChanges();
    expect(split.querySelectorAll(':scope > .cg-ap').length,
      'el arqueo volvió a meterse en el flujo y le quitó ancho a la lista').toBe(1);
  });

  it('⭐ el arqueo entra por un cajón a la DERECHA, no como columna', () => {
    /**
     * ⚠️ Esta prueba afirmaba **la izquierda**, y la afirmación era mía: el cajón nació ahí
     * porque a la derecha tapa la columna del IMPORTE de la cola. Edgar pidió la derecha el
     * 2026-10-19, así que el lado es una DECISIÓN SUYA, no una propiedad del diseño — y lo que
     * se prueba acá es que el cajón sale por donde se decidió, no que un lado sea el correcto.
     *
     * Lo que se pierde con la derecha, dicho para que no se redescubra: el panel tapa el
     * importe de la fila. No es grave porque el importe del movimiento elegido se repite
     * DENTRO del arqueo (la ficha y el renglón «documento»): cambia de lugar, no desaparece.
     */
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();

    const cajon: HTMLElement | null = fx.nativeElement.querySelector('app-side-peek .sp-root');
    expect(cajon, 'no se montó el cajón').not.toBeNull();
    expect(cajon!.classList.contains('is-open'), 'el cajón no abrió con la captura').toBe(true);
    expect(cajon!.classList.contains('is-izq'), 'el cajón salió por el lado equivocado').toBe(false);
    // Y el contenido del arqueo viaja adentro: la reja es lo que se teclea.
    expect(fx.nativeElement.querySelectorAll('app-side-peek input.cg-pieza').length)
      .toBeGreaterThan(0);
  });

  it('⭐ [CGA-LEG.9] el recorrido con teclado está ESCRITO, y lo escrito existe', async () => {
    /**
     * D.5: un atajo que nadie sabe que existe no existe — y para quien cuenta con las manos
     * ocupadas el atajo **es** la interfaz. Medido el 2026-10-19: la plantilla tiene 23 bindings
     * de teclado y sólo 5 teclas estaban anunciadas, todas dentro del arqueo. El bucle que la
     * persona repite decenas de veces al día —elegir, arquear, volver— no decía una palabra.
     *
     * ⛔ **Lo que esta prueba protege de verdad es la segunda mitad: que lo anunciado funcione.**
     * El prototipo tenía `/ buscar` y esta pantalla NO lo tiene: no hay ningún manejador global
     * de `/`. Un atajo escrito que no responde es peor que ninguno — se prueba una vez, no pasa
     * nada, y deja de creerse el resto del renglón.
     */
    // Con cola sembrada: el atajo promete algo SOBRE UNA FILA, así que sin filas la mitad que
    // importa no se podría comprobar — y una prueba que no puede fallar no prueba nada.
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const atajo: HTMLElement | null = fx.nativeElement.querySelector('.cg-atajo-cola');
    expect(atajo, 'el recorrido de la cola no se anuncia en ninguna parte').not.toBeNull();
    const teclas = Array.from(atajo!.querySelectorAll('kbd')).map((k) => (k.textContent ?? '').trim());
    expect(teclas, 'falta alguna de las cuatro teclas del recorrido')
      .toEqual(expect.arrayContaining(['←', '→', '↑', '↓', 'Enter', 'Esc']));

    // ⛔ [negativa] No se promete lo que no existe.
    expect(atajo!.textContent, 'se anuncia «/ buscar» y esta pantalla no tiene ese atajo')
      .not.toContain('/');

    // Y lo prometido RESPONDE: Enter sobre una fila abre el arqueo.
    const fila: HTMLElement | null = fx.nativeElement.querySelector('.cg-bandeja-tbl tbody tr');
    expect(fila, 'no hay fila con la cual comprobar lo que el atajo promete').not.toBeNull();
    expect(comp.capturaAbierta()).toBe(false);
    fila!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fx.detectChanges();
    expect(comp.capturaAbierta(), 'el atajo dice «Enter arquear» y Enter no abrió el arqueo').toBe(true);
  });

  it('⛔ [CG.120] la captura A MANO no se ofrece, pero la puerta compartida sigue viva', () => {
    /**
     * La captura a mano se retiró el 2026-10-19: un movimiento tecleado nace **sin
     * `origen_ref`**, o sea sin nada contra qué cuadrarlo — no lo alcanza el candado de
     * duplicados del servidor (que es por `origen_tipo + origen_ref`), no entra en el descuento
     * de la cola, y en la conciliación aparece como una fila que no corresponde a ningún
     * documento. Era la única puerta de esta pantalla por la que entraba dinero sin procedencia.
     *
     * ⛔ **Lo segundo que se afirma acá es lo que casi se rompe.** `abrirCaptura()` es la puerta
     * COMPARTIDA de cuatro caminos: la cola del ERP (`capturarDesde`), la bóveda
     * (`capturarDesdeCaos`), un recurrente sin regla (`declararDesdeRecurrente`) y el botón
     * retirado. Guardarla por dentro —que es lo que parece pedir «inhabilitar la captura
     * manual»— apagaría **el arqueo entero**. Por eso se apagó el botón y nada más, y por eso
     * esta prueba comprueba las dos mitades juntas: que la puerta manual no está Y que la
     * compartida sigue abriendo.
     *
     * ⚠️ Si alguien pone `CAPTURA_MANUAL_HABILITADA` en `true`, esta prueba se pone roja. Es a
     * propósito: devolver esa puerta es una decisión, no un descuido, y tiene que tocarse acá.
     */
    const fx = montar();
    fx.detectChanges();

    const botones: HTMLElement[] = Array.from(fx.nativeElement.querySelectorAll('button'));
    const manual = botones.find((b) => /Registrar movimiento/i.test(b.textContent ?? ''));
    expect(comp.puedeGestionar(), 'la prueba no sirve sin permiso de captura').toBe(true);
    expect(manual, 'se sigue ofreciendo capturar un movimiento a mano').toBeUndefined();

    // Y la puerta compartida NO se tocó: sin esto, el arqueo de la cola moriría en silencio.
    comp.abrirCaptura();
    expect(comp.capturaAbierta(), 'abrirCaptura() dejó de abrir: se guardó la puerta compartida')
      .toBe(true);
  });

  it('⭐ al elegir un movimiento el foco cae en el PRIMER campo de piezas', async () => {
    /**
     * ⛔ `[CG.117]` `enfocarDetalle()` buscaba `.cg-detail`, que se retiró al mudar el arqueo al
     * cajón. `querySelector` devolvía `null`, el `?.` se lo tragaba **en silencio** y el foco se
     * quedaba donde estuviera — medido en el navegador, terminaba en un botón del control
     * segmentado. Para empezar a contar había que ir al primer campo con el mouse.
     *
     * ⚠️ Un selector que no encuentra nada no es un error: es una función que se vuelve muda, y
     * el código sigue pareciendo correcto. Por eso la prueba mira **dónde quedó el foco**, no si
     * la función se llamó.
     */
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();
    // ⚠️ Se ESPERA el macrotask real, no se adelantan timers: esta suite no instala
    // `vi.useFakeTimers()`, y `runAllTimers` sin mocks lanza. `enfocarDetalle()` difiere con
    // `setTimeout(…, 0)` a propósito — el campo todavía no existe en el tick del `detectChanges`.
    await new Promise((r) => setTimeout(r, 0));

    const primera: HTMLElement | null =
      fx.nativeElement.querySelector('app-side-peek input.cg-pieza');
    expect(primera, 'no hay reja a la cual mandar el foco').not.toBeNull();
    expect(document.activeElement, 'el foco no cayó en el primer campo de piezas').toBe(primera);
  });

  it('⭐ al cerrar el cajón se cierra la captura: una sola fuente de verdad', () => {
    // El cajón cierra por Esc y por clic en el fondo, no sólo por «Cancelar». Si `openChange`
    // no estuviera cableado, cerrar por Esc dejaría `capturaAbierta()` en true y la pantalla
    // creería que se sigue capturando con el panel ya invisible.
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();
    expect(comp.capturaAbierta()).toBe(true);

    const peek: HTMLElement = fx.nativeElement.querySelector('app-side-peek .sp-backdrop');
    peek.click();
    fx.detectChanges();

    expect(comp.capturaAbierta(), 'cerrar el cajón no cerró la captura').toBe(false);
    expect(fx.nativeElement.querySelector('app-side-peek .sp-root')!.classList.contains('is-open'))
      .toBe(false);
  });

  it('⛔ el rótulo del apartado 1 DICE que la cola se toca cuando no hay nada elegido', () => {
    // La guía vivía en el vacío del arqueo («elige uno de la cola»), que se retiró al dejar de
    // pintarse. Si no la recoge el rótulo, la cola queda sin decir que es clicable.
    const fx = montar();
    const hint: HTMLElement = fx.nativeElement.querySelector('.cg-ap-que .cg-ap-hint');
    expect(hint, 'el apartado 1 no tiene rótulo').not.toBeNull();
    expect(hint.textContent, 'sin captura el rótulo tiene que decir qué hacer').toContain('cola');

    comp.abrirCaptura();
    fx.detectChanges();
    expect(hint.textContent, 'con captura abierta el rótulo dice qué se está cuadrando')
      .toContain('ERP');
  });

  // ── [CG.59] La pantalla es la tarea ──────────────────────────────────────────────────────
  //
  // Edgar: *"lo primero que debe ver el usuario es qué ingreso o egreso va a arquear, luego el
  // arqueo … el 90% de la pantalla debe ser ESTOS DOS APARTADOS … en ese 10% mostrarle un
  // desplegable de cómo va su jornada"*.

  it('la jornada arranca CERRADA, y aun así dice cómo va', () => {
    const fx = montar();
    expect(comp.jornadaAbierta()).toBe(false);

    const btn: HTMLElement | null = fx.nativeElement.querySelector('.cg-jornada-btn');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
    /**
     * `[CG.116]` **Abre una VENTANA, no despliega.** Antes acá se exigía `aria-expanded`, y eso
     * congelaba justo el defecto que Edgar reportó tres veces: un desplegable EMPUJA, así que
     * abrirlo movía de lugar el arqueo y los movimientos y el que estaba contando perdía el
     * renglón. Lo que el lector de pantalla anuncia tiene que ser lo que de verdad pasa.
     */
    expect(btn!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn!.getAttribute('aria-expanded')).toBeNull();
    // ⭐ Cerrada ya publica el estado del día.
    expect(btn!.textContent).toContain('Tu jornada');
    expect(btn!.textContent).toContain(comp.subtituloJornada());

    // Y el cuadre del día NO está en el DOM mientras esté cerrada: ocupaba ~360px de la tarea.
    expect(fx.nativeElement.querySelector('.cg-conc')).toBeNull();
  });

  /**
   * `[CG.123]` **La misma protección, repartida en las tres partes del selector.**
   *
   * Lo que esta prueba cuida no cambió: *la diferencia entre MOVER y borrar*. Lo que cambió es
   * que el diálogo ya no pinta todo de una vez — Edgar lo llamó «un asco» y lo medido le daba la
   * razón (3 rejillas, 39 cifras y 41 textos atenuados contra 5 enfatizados, en un solo
   * desplazamiento). Así que cada bloque se busca **en la parte donde vive**, y si alguno se
   * hubiera perdido en la mudanza, elegir su sección lo dejaría vacío y esto se pondría rojo.
   */
  it('⛔ [negativa] abrir la jornada NO pierde nada: todo lo que se mudó sigue ahí', () => {
    const fx = montarJornada();
    expect(comp.jornadaAbierta()).toBe(true);

    // «Hoy» es la parte por default: el cierre del día y su acción de rendir cuentas.
    const panel = (): Element => fx.nativeElement.querySelector('.cg-jornada');
    expect(comp.seccionJornada()).toBe('hoy');
    expect(panel().querySelector('.cg-conc')).not.toBeNull();
    expect(panel().textContent).toContain('Cerrar jornada');

    comp.seccionJornada.set('pendientes'); fx.detectChanges();
    expect(panel().querySelector('.cg-rec')).not.toBeNull();       // los que repiten sin cuenta

    comp.seccionJornada.set('historial'); fx.detectChanges();
    expect(panel().querySelector('.cg-historial')).not.toBeNull(); // el libro y los cortes
  });

  /**
   * ⛔⛔ `[CG.123]` **PRUEBA NEGATIVA DEL SELECTOR: lo que DECLARA un hueco no se esconde.**
   *
   * El primer intento de este cambio metió las tres regiones detrás del selector y listo. Nueve
   * pruebas se pusieron rojas y **tenían razón**: con los cortes caídos, el aviso «no se pudieron
   * leer» vivía DENTRO de la sección Historial, así que en la vista por default una lectura
   * **fallida quedaba invisible**. Publicar nada es peor que publicar un cero (ADR-056) — es el
   * mismo defecto que `[CG.181]` vino a arreglar, con una capa encima.
   *
   * Por eso las declaraciones subieron sobre el selector. Esto lo fija: parado en «Hoy», que es
   * donde la persona abre, los tres huecos se leen igual.
   */
  it('⛔ [negativa] parado en «Hoy», lo que no se pudo medir se sigue diciendo', () => {
    const fx = montarJornada({
      libro: vi.fn(() => throwError(() => new Error('timeout'))),
      cortes: vi.fn(() => throwError(() => new Error('timeout'))),
      // ⚠️ `recurrentesSinRegla`, NO `recurrentes`: un doble que nombra un método que el
      // servicio no tiene no simula nada — el componente llama al real y la prueba verde
      // estaría midiendo el camino sano. Lo delató el selector publicando «Pendientes 57».
      recurrentesSinRegla: vi.fn(() => throwError(() => new Error('timeout'))),
    });
    expect(comp.seccionJornada()).toBe('hoy');

    const txt: string = fx.nativeElement.querySelector('.cg-jornada').textContent;
    expect(txt).toContain('el libro no se pudo leer');
    expect(txt).toContain('los cortes no se pudieron leer');
    expect(txt).toContain('Sin medir');
  });

  /**
   * ⭐ `[CG.116]` **La jornada no empuja: vive en una ventana.** Pedido de Edgar tres veces, la
   * última con el pantallazo a la vista: *"al hacer que el usuario despliegue y deslice hacia
   * abajo pierde el enfoque... que esto viva en un selector para no tener esa perdida de la
   * pantalla principal, o se abre una pestaña nueva o se despliega una ventana"*.
   *
   * La aserción que importa es la SEGUNDA: que el panel **no** sea hijo del tablero. Comprobar
   * sólo que existe un `p-dialog` lo pasaría también una pantalla que abra la ventana Y además
   * siga empujando — que es el defecto con una capa encima.
   */
  it('[CG.116] la jornada abre una VENTANA y no empuja el tablero', () => {
    const fx = montarJornada();
    const panel: Element | null = fx.nativeElement.querySelector('.cg-jornada');
    expect(panel).not.toBeNull();
    expect(panel!.closest('p-dialog')).not.toBeNull();
    // ⛔ Y NO cuelga del tablero: si colgara, abrirla volvería a correr el arqueo hacia abajo.
    expect(fx.nativeElement.querySelector('.cg-app > .cg-jornada')).toBeNull();
  });

  it('⛔ [CG.116 negativa] cerrada, el tablero no tiene ni rastro del panel', () => {
    const fx = montar();
    expect(comp.jornadaAbierta()).toBe(false);
    expect(fx.nativeElement.querySelector('.cg-conc')).toBeNull();
    // El botón sigue ahí y sigue resumiendo: la ventana no se lleva el estado del día.
    expect(fx.nativeElement.querySelector('.cg-jornada-btn')!.textContent).toContain('Tu jornada');
  });

  /**
   * ⭐ `[CG.115]` **Lo suelto de OTRAS jornadas se declara con su monto.**
   *
   * Nace de que el esperado salía en −$206,008.34: el corte barría todo lo que tuviera
   * `corte_id IS NULL` sin mirar la fecha, así que un corte del 12-oct se tragaba $130,000 del
   * 25-sep y hasta un movimiento fechado 10-dic. Acotarlo a su día sin publicar esto sería el
   * defecto simétrico — el dinero dejaría de torcer el esperado y también de verse.
   */
  it('[CG.115] lo suelto de otras jornadas se declara, con día y monto', () => {
    const fx = montarJornada({
      saldo: vi.fn(() => of({
        ...SALDO,
        dia: '2026-10-12',
        sueltos_fuera: {
          dia: '2026-10-12',
          anteriores: { movimientos: 5, neto: -121775 },
          posteriores: { movimientos: 3, neto: -58524 },
          desde: '2026-09-25', hasta: '2026-12-10',
        },
      })),
    });
    const caja: string = fx.nativeElement.querySelector('.cg-fuera').textContent;
    expect(caja).toContain('5 de días anteriores');
    // [CGP-V.7] La fecha va en palabras, no ISO cruda: es una frase.
    expect(caja).toContain('desde el 25-sep');
    expect(caja).not.toContain('2026-09-25');
    expect(caja).toContain('3 con fecha posterior');
    expect(caja).toContain('hasta el 10-dic');
    // El monto, no sólo el conteo: un pendiente sin cifra no se puede priorizar.
    expect(caja).toContain('121,775');
    // ⭐ Y dice que NO entran al corte — que es la razón de que el esperado ya no sea un disparate.
    expect(caja).toContain('No entran a este corte');
  });

  it('⛔ [CG.115 negativa] sin pendientes de otros días la caja NO se pinta', () => {
    // `null` acá significa "no hay nada fuera", y eso NO puede verse igual que "no se midió":
    // dibujar la caja en ceros inventaría un pendiente que no existe.
    const fx = montarJornada({ saldo: vi.fn(() => of({ ...SALDO, dia: '2026-10-12', sueltos_fuera: null })) });
    expect(fx.nativeElement.querySelector('.cg-fuera')).toBeNull();
  });

  it('⛔ [negativa] la reja pregunta por SU apartado, no por una caja de más arriba', () => {
    // El defecto que esto congela, reportado por Edgar con captura: la reja del arqueo se apila con
    // `@container (max-width:26rem)`, pero el único `container-type` estaba en `.cg-detail-cuerpo`.
    // O sea que la consulta medía los ~646px del PANEL en vez de los ~311px de la caja donde la
    // reja vive. Nunca disparaba: dos columnas de reja dentro de una de 311px, cada sub-tabla a
    // ~150px, con scroll horizontal y la columna «Importe» cortada.
    //
    // ⚠️ Una consulta de contenedor NO falla cuando apunta a la caja equivocada: contesta, y
    // contesta sobre otra cosa. jsdom no hace layout, así que esto no se puede probar renderizando;
    // lo que sí se puede exigir es que la caja donde la reja vive DECLARE que es un contenedor.
    // `[CG.60]` esa caja es `.cg-ap-cuerpo` — antes era `.cg-col`, que ya no existe.
    const meta = FinanzasCajaGeneralComponent as unknown as { ɵcmp?: { styles?: string[] } };
    const css = (meta.ɵcmp?.styles ?? []).join('\n');

    expect(css).toContain('26rem');                      // la reja pregunta

    // ⚠️ El CSS compilado lleva los atributos `_ngcontent-…` inyectados en cada selector, así que
    // un regex pegado al selector literal es frágil. Se busca por VENTANA: alguna regla que
    // mencione `.cg-ap-cuerpo` y declare `container-type` cerca.
    const declaraContenedor = css
      .split('.cg-ap-cuerpo')
      .slice(1)
      .some((trozo) => /^[^}]{0,400}container-type\s*:\s*inline-size/.test(trozo));
    expect(declaraContenedor, 'el apartado no declara que es contenedor de consulta').toBe(true);
  });

  it('⛔ [negativa] la reja vive DENTRO de la caja que declara el contenedor', () => {
    // El complemento del anterior, y lo que de verdad falló: declarar `container-type` no alcanza
    // si la reja termina en otra rama del DOM. Acá se pregunta por el PARENTESCO real, que es lo
    // único que jsdom sí puede contestar sin layout.
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();

    const reja: Element | null = fx.nativeElement.querySelector('.cg-reja2');
    expect(reja, 'la reja se pinta al capturar').not.toBeNull();
    expect(reja!.closest('.cg-ap-cuerpo'), 'la reja quedó fuera de su contenedor de consulta')
      .not.toBeNull();
  });

  // ⭐ [CG.60] Acá vivía «los dos umbrales del panel son COMPLEMENTARIOS»: `.cg-grid` colapsaba en
  // 39rem y la posición de las columnas se fijaba en 39.01, y si esos dos números se separaban
  // quedaba una franja de anchos con las columnas invertidas **en silencio**.
  //
  // Esos dos umbrales se fueron con `.cg-grid`, y la prueba se va con ellos — pero el DAÑO que
  // vigilaba no: «el CUÁNTO se va a la izquierda sin que nadie lo note». Eso ahora sólo puede
  // pasar de una forma, y es la que se congela abajo: que una regla reordene los apartados.

  it('⛔ [negativa] NADA reordena los dos apartados: el orden no se decide en el CSS', () => {
    const meta = FinanzasCajaGeneralComponent as unknown as { ɵcmp?: { styles?: string[] } };
    const css = (meta.ɵcmp?.styles ?? []).join('\n');
    expect(css.length).toBeGreaterThan(0);

    // `order:` y `grid-column:` sobre un apartado son las dos formas de invertirlos sin tocar el
    // DOM — justo el pie del que ya resbalamos. El orden lo manda el DOM, y sólo el DOM.
    //
    // ⚠️ La propiedad va anclada al principio de una declaración. Sin eso, `border:1px` contiene
    // literalmente `order:1` y la prueba se pone roja sobre su propia tarjeta: un falso positivo
    // que, de haberlo "arreglado" aflojando el regex, habría dejado la guardia sin filo.
    const reordena = css
      .split('.cg-ap')
      .slice(1)
      .filter((trozo) => /^[^}]{0,300}?[;{]\s*(order\s*:\s*-?\d|grid-column\s*:)/.test(';' + trozo));
    expect(reordena, 'una regla reordena los apartados: ' + reordena.join(' | ')).toEqual([]);
  });

  /**
   * ⚠️ 2026-10-16 — REESCRITA PARA EL CAJÓN. Antes afirmaba dos `.cg-ap` hermanos dentro del
   * split. Ya no son hermanos: la lista ocupa la pantalla y el arqueo entra por un cajón.
   *
   * ⭐ Lo que se afirma NO se afloja, se traslada: el ORDEN DE LECTURA sigue siendo primero
   * qué se va a arquear y después el arqueo — y en un cajón modal eso importa MÁS que antes,
   * porque un `aria-modal` que aparece ANTES de la lista en el DOM deja al lector de pantalla
   * entrando por el panel sin haber visto de qué es.
   */
  it('el QUÉ va primero y el ARQUEO después: el DOM es el orden de lectura', async () => {
    const fx = montar();
    comp.abrirCaptura();
    await Promise.resolve();
    fx.detectChanges();

    const que: HTMLElement = fx.nativeElement.querySelector('.cg-ap-que');
    const cajon: HTMLElement = fx.nativeElement.querySelector('app-side-peek');
    expect(que, 'no está el apartado 1').not.toBeNull();
    expect(cajon, 'no está el cajón del arqueo').not.toBeNull();

    // `DOCUMENT_POSITION_FOLLOWING` = el cajón viene DESPUÉS del apartado 1 en el documento.
    // eslint-disable-next-line no-bitwise
    const despues = !!(que.compareDocumentPosition(cajon) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(despues, 'el cajón se montó ANTES de la lista en el DOM').toBe(true);

    // Y la lista sigue siendo el único apartado del flujo: el cajón no le quita ancho.
    const aps = Array.from(fx.nativeElement.querySelectorAll('.cg-split > .cg-ap')) as HTMLElement[];
    expect(aps.length).toBe(1);
    expect(aps[0].classList.contains('cg-ap-que')).toBe(true);
  });

  it('cerrar un diálogo DEVUELVE el foco a donde estaba (PrimeNG no lo hace)', async () => {
    const fx = montar();
    // Verificado en node_modules: p-dialog trae closeOnEscape/focusOnShow/focusTrap, pero CERO
    // restauración del foco al cerrar. Sin esto, cerrar deja el foco en el <body>.
    const disparador = document.createElement('button');
    document.body.appendChild(disparador);
    disparador.focus();
    expect(document.activeElement).toBe(disparador);

    comp.abrirCaptura();
    fx.detectChanges();
    comp.cerrarConFoco(comp.capturaAbierta);
    await new Promise((r) => setTimeout(r, 0));

    expect(document.activeElement).toBe(disparador);
    disparador.remove();
  });

  // ── 11 · DECLARAR LA CUENTA: el bloqueo del módulo entero ────────────────────────────────
  //
  // Punto 5. La bandeja decía "0 de 8 se confirman · el resto necesita que su cuenta esté
  // declarada" y NO HABÍA POR DÓNDE DECLARARLA: medido, `caja_classify_rules` tenía 0 filas en
  // prod y no existía ninguna pantalla para cargarlas. No era falta de trabajo, era falta de
  // puerta. Se declara desde la captura, donde la persona tiene el beneficiario delante.

  function capturaDeGastoLista() {
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    comp.setF('beneficiario', 'GASTOS GENERALES CAJA CHICA MORELIA ABASTOS');
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'VIATICOS');
    comp.setF('glosa', 'gasto de caja chica');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 200: 1, 50: 1 });         // 250 — el monto sale del conteo, no del teclado
  }

  it('sólo se ofrece declarar donde la regla APLICA: gasto, con beneficiario y par completo', () => {
    montar();
    comp.abrirCaptura();
    expect(comp.puedeDeclararRegla()).toBe(false);

    capturaDeGastoLista();
    expect(comp.puedeDeclararRegla()).toBe(true);

    // El motor clasifica EGRESOS por beneficiario; ofrecerlo en un ingreso prometería un efecto
    // que no va a ocurrir.
    comp.setF('tipo', 'ingreso');
    expect(comp.puedeDeclararRegla()).toBe(false);
  });

  it('con el check puesto, guardar DECLARA la cuenta del beneficiario', () => {
    montar();
    capturaDeGastoLista();
    comp.declararRegla.set(true);
    comp.guardar();

    const body = svc['declararRegla'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body).toBeTruthy();
    expect(body['beneficiario']).toBe('GASTOS GENERALES CAJA CHICA MORELIA ABASTOS');
    expect(body['kepler_cuenta']).toBe('601-001');
    expect(body['kepler_concepto']).toBe('VIATICOS');
  });

  it('sin el check, NO se declara nada: una regla contable no es un default', () => {
    montar();
    capturaDeGastoLista();
    comp.guardar();
    expect(svc['declararRegla']).not.toHaveBeenCalled();
  });

  it('nace apagado en cada captura', () => {
    montar();
    capturaDeGastoLista();
    comp.declararRegla.set(true);
    comp.abrirCaptura();
    expect(comp.declararRegla()).toBe(false);
  });

  it('si declarar falla, el movimiento YA quedó guardado y se avisa', () => {
    montar({ declararRegla: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    capturaDeGastoLista();
    comp.declararRegla.set(true);

    expect(() => comp.guardar()).not.toThrow();
    // El efectivo se registró: `crear` corrió y el diálogo se cerró.
    expect(svc['crear']).toHaveBeenCalled();
    expect(comp.capturaAbierta()).toBe(false);
  });

  it('sin documento anclado no viaja monto_contado (no hay contra qué contar)', () => {
    montar();
    comp.abrirCaptura();
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'gasto suelto');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    contar({ 500: 1 });
    comp.guardar();

    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body['monto_contado']).toBeUndefined();
    expect(body['origen_tipo']).toBe(null);
  });

  // ── 12 · CG.23 · EL ARQUEO ───────────────────────────────────────────────────────────────
  //
  // Pedido de Edgar (2026-09-23) sobre la pantalla ya construida: "el desglose no es opcional.
  // ademas, no esta bien diseñada la interfaz, no tiene para moverte con las flechas del
  // teclado, los valores tienen que ser disable, en valores, existen billetes de 500, 200,
  // 100, 50 y 20. monedas no es necesario desglosarlo. en morralla queda perfecto".
  //
  // Las aserciones van contra el DOM y no contra los métodos: los cuatro defectos vivían en la
  // PLANTILLA (un <details> plegado, un p-inputnumber que se come las flechas, un total
  // editable), y un test que llame al método pasa igual con todos ellos puestos.

  async function capturaEnPantalla() {
    const fx = montar();
    comp.abrirCaptura();
    fx.detectChanges();
    await Promise.resolve();
    fx.detectChanges();
    return fx;
  }

  const inputsPieza = (fx: { nativeElement: HTMLElement }) =>
    Array.from(fx.nativeElement.querySelectorAll('input.cg-pieza')) as HTMLInputElement[];

  it('[negativa] la reja se ve SIEMPRE: ya no está plegada ni rotulada "(opcional)"', async () => {
    const fx = await capturaEnPantalla();
    expect(fx.nativeElement.querySelector('.cg-arqueo')).toBeTruthy();
    // El <details> era el problema: plegado, el camino fácil era no contar.
    expect(fx.nativeElement.querySelectorAll('details').length).toBe(0);
    expect((fx.nativeElement.innerHTML as string)).not.toContain('(opcional)');
  });

  /**
   * `[CG.38]` Esta prueba decía *"son cinco billetes … y ninguna moneda suelta"* y afirmaba
   * `not.toContain('50¢')`. Era correcta: fijaba la decisión de `[CG.23]` —*"monedas no es
   * necesario desglosarlo, en morralla queda perfecto"*—. Edgar la revirtió el 2026-10-06:
   * *"la morralla se cuenta por denominación"*. Lo que cambió es el REQUISITO, no el código:
   * por eso la prueba se reescribe entera en vez de aflojarle un número.
   */
  /**
   * ⭐ 2026-10-16 — Y SE DA VUELTA OTRA VEZ, por el mismo motivo: cambió el requisito. Edgar
   * pidió el billete de $1,000. El código ya decía qué costaba —*"agregar su llave a esta
   * lista, sin migración"*— porque el CHECK de `finance.cash_ledger_denominations` siempre
   * admitió las 14 denominaciones; la reja ofrecía 5 por decisión, no por límite.
   *
   * ⚠️ Lo que se gana no es comodidad: mientras el de $1,000 no estuvo, un billete de mil que
   * entraba sólo podía declararse partido en otras denominaciones o volcado en morralla. El
   * arqueo cuadraba en el TOTAL y mentía en la COMPOSICIÓN — y la composición es lo único que
   * permite reconstruir qué había en la mano.
   */
  it('son SEIS billetes y seis monedas, más el resto suelto', async () => {
    const fx = await capturaEnPantalla();
    // 6 billetes + 6 monedas + 1 de resto suelto.
    expect(inputsPieza(fx).length).toBe(13);

    // Acotado AL BLOQUE del arqueo: sobre el innerHTML de la página entera, "$1,000" aparece
    // en la tira de KPIs y la prueba fallaba por un importe que no tiene nada que ver.
    const reja: string = fx.nativeElement.querySelector('.cg-arqueo').innerHTML;
    for (const b of ['$1,000', '$500', '$200', '$100', '$50', '$20']) expect(reja).toContain(b);
    expect(reja).toContain('50¢');          // el metal AHORA sí se desglosa
    expect(reja).toContain('Morralla');     // y queda el campo suelto para lo de menos de 50¢
  });

  it('⭐ el de $1,000 CUENTA: dos billetes son $2,000 en el monto del movimiento', async () => {
    // Ofrecerlo en la reja y que no sume sería peor que no ofrecerlo: el desglose diría mil
    // y el monto diría cero. Se ejercita el camino completo, no la presencia del renglón.
    await capturaEnPantalla();
    contar({ 1000: 2 });
    expect(comp.f().monto).toBe(2000);
    expect(comp.f().denominaciones.find((d) => d.denom_key === '1000')?.piezas).toBe(2);
  });

  /**
   * ⭐ La prueba que justifica todo el re-tecleo. El billete y la moneda de $20 valen lo mismo y
   * son cosas distintas; con la identidad en el VALOR —como estaba— la segunda pisaba a la
   * primera y una de las dos pilas de dinero desaparecía del desglose.
   */
  /**
   * `[CG.38]` El cambio que se devuelve. Hasta esta fase no había dónde registrarlo: si te daban
   * $5,000 por un documento de $4,830, los $170 que volvían al cliente **no existían en ningún
   * lado** y la caja declaraba efectivo que ya no tenía.
   */
  describe('[CG.38] el cambio que se devuelve', () => {
    it('⭐ el monto del movimiento es el NETO: entró menos lo devuelto', () => {
      montar();
      comp.setPiezas(den('500'), 10);                 // entran 5,000
      expect(comp.f().monto).toBe(5000);

      comp.setPiezasDevueltas(den('100'), 1);
      comp.setPiezasDevueltas(den('50'), 1);
      comp.setPiezasDevueltas(den('20'), 1);          // se devuelven 170

      expect(comp.totalDevuelto()).toBe(170);
      expect(comp.f().monto).toBe(4830);              // y NO 5,000
    });

    it('arranca PLEGADO: el caso común no paga el costo del caso raro', () => {
      montar();
      expect(comp.cambioAbierto()).toBe(false);
      expect(comp.hayDevuelto()).toBe(false);
    });

    it('con cambio cargado NO se puede plegar y perderlo de vista', () => {
      montar();
      comp.setPiezasDevueltas(den('100'), 1);
      // `hayDevuelto` mantiene el bloque abierto aunque el toggle diga que no.
      expect(comp.cambioAbierto()).toBe(false);
      expect(comp.hayDevuelto()).toBe(true);
    });

    it('⛔ [negativa] devolver MÁS de lo que entró se nombra con su monto', () => {
      montar();
      comp.setPiezas(den('100'), 1);                  // entran 100
      comp.setPiezasDevueltas(den('500'), 1);         // se devuelven 500
      const r = comp.resumenCambio();
      expect(r.neto).toBe(-400);
      expect(r.problema).toContain('400.00');
    });

    it('⛔ [negativa] entró y salió lo mismo: se avisa que eso es un canje', () => {
      montar();
      comp.setPiezas(den('500'), 1);
      comp.setPiezasDevueltas(den('100'), 5);
      const r = comp.resumenCambio();
      expect(r.neto).toBe(0);
      expect(r.problema).toContain('canje');
    });

    /**
     * ⛔ El bug de dinero que esto previene: sin limpiar, la captura siguiente arranca con el
     * cambio de la anterior **ya restado del monto**, y encima en silencio porque el bloque nace
     * plegado. Todas las puertas del diálogo pasan por `abrirCaptura()`, así que se prueba ahí.
     */
    it('⛔ [negativa] el cambio NO sobrevive al diálogo anterior', () => {
      montar();
      comp.setPiezasDevueltas(den('100'), 2);
      expect(comp.totalDevuelto()).toBe(200);

      comp.abrirCaptura();
      expect(comp.totalDevuelto()).toBe(0);
      expect(comp.devuelto()).toEqual([]);
      expect(comp.cambioAbierto()).toBe(false);
    });

    it('lo devuelto viaja al servidor con su flujo, no mezclado con lo que entró', () => {
      const crear = vi.fn(() => of({ id: 'x', folio: 'CG-1' } as any));
      montar({ crear });
      comp.abrirCaptura();
      comp.setF('kepler_cuenta', '601-001');
      comp.setF('kepler_concepto', 'PAPELERIA');
      comp.setF('glosa', 'entrega de ruta');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
      comp.setF('fecha', todayMx());
      comp.setPiezas(den('500'), 10);
      comp.setPiezasDevueltas(den('100'), 1);
      expect(comp.bloqueos()).toEqual([]);          // si algo lo traba, la prueba lo dice acá
      comp.guardar();

      const body = crear.mock.calls[0][0] as any;
      const recibido = body.denominaciones.filter((d: any) => d.flujo === 'recibido');
      const devuelto = body.denominaciones.filter((d: any) => d.flujo === 'devuelto');
      expect(recibido.length).toBe(1);
      expect(devuelto.length).toBe(1);
      expect(devuelto[0].denom_key).toBe('100');
      expect(body.monto).toBe(4900);                 // 5,000 − 100
    });

    it('la reja del cambio tiene SU PROPIA clase: la flecha no salta entre columnas', async () => {
      const fx = await capturaEnPantalla();
      comp.cambioAbierto.set(true);
      fx.detectChanges();
      const dev = fx.nativeElement.querySelectorAll('input.cg-pieza-dev');
      const ent = fx.nativeElement.querySelectorAll('input.cg-pieza');
      expect(dev.length).toBe(12);                    // 6 billetes (con el de $1,000) + 6 monedas
      // ⛔ Si compartieran selector, contar en una columna movería el foco a la otra.
      expect([...dev].some((i: Element) => i.classList.contains('cg-pieza'))).toBe(false);
      expect(ent.length).toBeGreaterThan(0);
    });
  });

  it('⭐ [CG.38] el billete y la moneda de $20 se cuentan POR SEPARADO', () => {
    montar();
    comp.setPiezas(den('20'), 3);      // billetes
    comp.setPiezas(den('20m'), 4);     // monedas

    expect(comp.piezasDe(den('20'))).toBe(3);
    expect(comp.piezasDe(den('20m'))).toBe(4);
    expect(comp.f().denominaciones.length).toBe(2);        // DOS renglones, no uno
    expect(comp.f().monto).toBe(140);                      // 60 + 80
  });

  it('⛔ [negativa] contar la moneda de $20 NO pisa al billete de $20', () => {
    montar();
    comp.setPiezas(den('20'), 3);
    expect(comp.f().monto).toBe(60);
    comp.setPiezas(den('20m'), 4);
    // Con la identidad en el valor, esto habría dado 80: la moneda reemplazaba al billete.
    expect(comp.f().monto).toBe(140);
    expect(comp.piezasDe(den('20'))).toBe(3);
  });

  it('[negativa] el MONTO no se puede teclear: sale del conteo y NO es un campo', async () => {
    const fx = await capturaEnPantalla();
    // ⭐ `[CG.53]` Esto era un `<input disabled>` en el pie de la tabla y ahora es el número grande
    // de la pantalla. La afirmación se endurece: antes había un campo apagado, hoy **no hay campo**.
    expect(fx.nativeElement.querySelector('input#cg-monto')).toBeNull();
    expect(fx.nativeElement.querySelector('.cg-total-n')).not.toBeNull();

    // Y sigue sin haber ninguna forma de teclear el monto dentro del bloque del total.
    const bloque: Element = fx.nativeElement.querySelector('.cg-total-bloque');
    expect(bloque.querySelectorAll('input, textarea, select').length).toBe(0);
  });

  // ── [CG.54] Limpieza: el mismo hecho, en UN lugar ────────────────────────────────────────
  //
  // Edgar: *"limpiemos cosas innecesarias. hay que optimizar la vista"*. Medido antes de cortar:
  // el importe del documento anclado aparecía **cinco veces** en el mismo panel — el encabezado,
  // la pista «Kepler: …», el pie del crédito, la cabecera del arqueo y el bloque del número.
  // Tres de las cinco las había agregado yo en `[CG.49]` y `[CG.53]`.

  it('el importe del documento se dice DOS veces, y cada una tiene su oficio', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);        // el documento dice 1060
    await Promise.resolve();
    fx.detectChanges();

    const cuenta = (sel: string) => {
      const caja: Element | null = fx.nativeElement.querySelector(sel);
      expect(caja, 'no existe ' + sel).not.toBeNull();
      return [(caja!.textContent ?? '').split('1,060.00').length - 1, caja!.textContent ?? ''] as const;
    };

    // ⭐ [CG.60] Dos, no cinco — y ahora **una por apartado**, que es más estricto que «dos en el
    // panel»: el apartado 1 lo dice como la FICHA (lo que el documento declara) y el apartado 2
    // como la META (contra cuánto tiene que cuadrar lo contado). Cualquier tercera, en cualquiera
    // de los dos, es un eco que alguien va a tener que ir a verificar que diga lo mismo.
    const [enFicha, textoFicha] = cuenta('.cg-detail');
    const [enArqueo] = cuenta('.cg-ap-arqueo');
    expect(enFicha, 'el apartado 1 lo dice una sola vez').toBe(1);
    expect(enArqueo, 'el apartado 2 lo dice una sola vez').toBe(1);

    // Y lo que se fue, se fue: la pista larga ya no está, ni el subtítulo que [CG.49] había puesto
    // en el encabezado del panel y que la ficha dejó sin oficio.
    expect(textoFicha).not.toContain('El monto sale del arqueo, no del documento');
    expect(textoFicha).not.toContain('El documento dice');
  });

  it('⛔ [negativa] en un GASTO no se ofrece «Venta a crédito»: ahí no significa nada', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);        // GASTO_TRABADO.tipo === 'gasto'
    await Promise.resolve();
    fx.detectChanges();

    expect(comp.f().tipo).toBe('gasto');
    // Una venta a crédito es, por definición, parte de un COBRO que no llegó en efectivo. Colgaba
    // de `cobroElegido()` a secas y desde CG.21 el egreso también se ancla, así que un comprobante
    // de gasto mostraba el campo. El servidor acepta `venta_credito` sin mirar el tipo: el freno va
    // en la pantalla.
    expect(fx.nativeElement.querySelector('#cg-vcredito')).toBeNull();
  });

  it('el veredicto del arqueo distingue TRES ausencias, no dos', () => {
    // ⚠️ Anclado a un documento DE VERDAD: `capturaEnPantalla()` abre una captura libre y ahí no
    // hay contra qué cuadrar. Lo encontró esta misma prueba, afirmando 'cuadra' sobre una captura
    // sin documento — que es exactamente el cuadre inventado que el tercer estado existe para
    // evitar.
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);          // el documento dice 1060

    // Sin contar no es "no cuadra": es que todavía no hay cifra.
    expect(comp.arqueoVeredicto().estado).toBe('sin_contar');

    contar({ 500: 2, 20: 3 });                  // 1060
    expect(comp.arqueoVeredicto().estado).toBe('cuadra');

    contar({ 500: 2, 20: 4 });                  // 1080
    const v = comp.arqueoVeredicto();
    expect(v.estado).toBe('sobra');
    expect(v.dif).toBe(20);
    expect(comp.textoVeredicto(v)).toContain('Sobra');
    expect(v.esperado).toBe(1060);
  });

  it('⛔ [negativa] sin documento anclado NO se pinta un cuadre que nadie comprobó', () => {
    montar();
    comp.abrirCaptura();          // captura libre: sin ancla en Kepler
    comp.setPiezas(den(500), 2);
    const v = comp.arqueoVeredicto();
    expect(v.estado).toBe('sin_documento');
    expect(v.esperado).toBeNull();
    // Lo contado es la verdad, pero no hay contra qué cuadrarlo — y eso se dice.
    expect(comp.textoVeredicto(v)).toContain('Sin documento');
  });

  it('contar llena el monto y el importe del renglón, sin tocar el teclado del total', async () => {
    const fx = await capturaEnPantalla();
    contar({ 500: 2, 20: 3 });
    fx.detectChanges();

    expect(comp.subtotalDe(den(500))).toBe(1000);
    expect(comp.subtotalDe(den(20))).toBe(60);
    expect(comp.f().monto).toBe(1060);

    // `[CG.53]` El total dejó de ser un input apagado y es el número grande de la pantalla.
    const monto: Element | null = fx.nativeElement.querySelector('.cg-total-n');
    expect(monto).not.toBeNull();
    expect(monto!.textContent).toContain('1,060');
  });

  it('la morralla suma al monto sin desglosarse: "en morralla queda perfecto"', async () => {
    await capturaEnPantalla();
    contar({ 100: 1 });
    comp.setMorralla(7.5);
    expect(comp.f().monto).toBe(107.5);
  });

  it('las piezas son ENTERAS y no negativas: medio billete no existe', async () => {
    await capturaEnPantalla();
    comp.setPiezas(den(100), 3.7);
    expect(comp.piezasDe(den(100))).toBe(3);
    comp.setPiezas(den(100), -2);
    expect(comp.piezasDe(den(100)), '[CG.114] un negativo no se guarda: la caja vuelve a VACIA, no a un 0 tecleado').toBeNull();
  });

  it('Enter y la flecha abajo bajan por la reja, como se cuenta un fajo', async () => {
    const fx = await capturaEnPantalla();
    const ins = inputsPieza(fx);

    ins[0].focus();
    ins[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).toBe(ins[1]);

    ins[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(ins[2]);
  });

  it('la flecha arriba sube, y baja hasta Morralla: el conteo termina donde termina el dinero', async () => {
    const fx = await capturaEnPantalla();
    const ins = inputsPieza(fx);

    ins[2].focus();
    ins[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(ins[1]);

    // El último salto cae en Morralla, que está en la misma columna a propósito.
    //
    // ⚠️ `[CG.38]` Los índices eran 4 y 5, fijos, de cuando la reja tenía 5 billetes. Con las
    // monedas pasó a 12 renglones y la prueba se puso roja sin que el comportamiento cambiara.
    // Se cuenta desde el FINAL: lo que se afirma es "el penúltimo salta al último, y el último
    // es Morralla", que es verdad con cualquier cantidad de denominaciones.
    const ultimo = ins.length - 1;
    ins[ultimo - 1].focus();
    ins[ultimo - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(ins[ultimo]);
    expect(ins[ultimo].classList.contains('cg-morralla-in')).toBe(true);
  });

  it('[negativa] en el BORDE de la reja la flecha no incrementa lo contado', async () => {
    // El defecto real que encontró esta prueba: `moverFoco` hacía `return` antes de
    // `preventDefault()` cuando no había renglón siguiente. En el primero y en el último —que
    // es donde más se teclea— la flecha caía al comportamiento nativo del input numérico y
    // SUMABA UNO a las piezas. En un arqueo, dinero que aparece solo.
    const fx = await capturaEnPantalla();
    const ins = inputsPieza(fx);

    ins[0].focus();
    const arriba = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    ins[0].dispatchEvent(arriba);
    expect(arriba.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ins[0]);

    const ultimo = ins[ins.length - 1];
    ultimo.focus();
    const abajo = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    ultimo.dispatchEvent(abajo);
    expect(abajo.defaultPrevented).toBe(true);
  });

  // ── 13 · CG.23.2 · QUE EL MOVIMIENTO APAREZCA SOLO ───────────────────────────────────────
  //
  // Pedido de Edgar: "cuando aparezca en kepler y envie un nuevo ingreso o egreso debe mostrarse
  // al momento en el sistema".
  //
  // Medido antes de tocar: la pantalla NO se refrescaba NUNCA. `cargarPendientes()` corría al
  // entrar y después de guardar, y nada más — una caja abierta toda la mañana mostraba la foto
  // del momento en que se abrió. No había ni polling ni socket; el repo tampoco tenía un solo
  // `LISTEN`/`NOTIFY` (grep: cero).

  const evento = (o: Partial<CajaEvent> = {}): CajaEvent => ({
    origen: 'feed', filas: 10, max_folio: '0001300', max_captura: '2026-09-23',
    firma: '10|0001300|2026-09-23|1000.00', datos_al: '2026-09-23T15:00:00Z',
    emitted_at: '2026-09-23T15:00:01Z', ...o,
  });

  it('se conecta al canal en vivo al entrar y lo suelta al salir', () => {
    montar();
    expect(cajaSock.connect).toHaveBeenCalled();
    comp.ngOnDestroy();
    expect(cajaSock.disconnect).toHaveBeenCalled();
  });

  it('un aviso con firma NUEVA va a buscar los movimientos', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    const antes = svc['movimientosPendientes'].mock.calls.length;

    cajaSock.change$.next(evento({ firma: 'otra-firma' }));

    expect(svc['movimientosPendientes'].mock.calls.length).toBeGreaterThan(antes);
  });

  it('[negativa] el MISMO aviso dos veces NO vuelve a consultar', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    cajaSock.change$.next(evento());
    const tras1 = svc['movimientosPendientes'].mock.calls.length;

    // El carril refresca cada pasada haya o no novedad; sin esta comparación, cada pasada
    // dispararía una consulta por pestaña abierta aunque no hubiera cambiado nada.
    cajaSock.change$.next(evento());
    expect(svc['movimientosPendientes'].mock.calls.length).toBe(tras1);
  });

  it('un aviso del LIBRO siempre va a buscar, aunque repita firma', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    cajaSock.change$.next(evento());
    const tras1 = svc['movimientosPendientes'].mock.calls.length;

    // Lo dispara alguien que acaba de guardar acá: la firma es la del corte de Kepler y no se
    // movió, pero el libro sí. Si se comparara igual que el feed, la otra pantalla no se entera.
    cajaSock.change$.next(evento({ origen: 'libro', firma: null }));
    expect(svc['movimientosPendientes'].mock.calls.length).toBeGreaterThan(tras1);
  });

  it('[negativa] si el canal en vivo revienta, la pantalla igual carga', () => {
    // Es un EXTRA, no el mecanismo: sin sesión, con un proxy que bloquea el websocket o con el
    // backend sin desplegar, la caja tiene que seguir funcionando. Antes de envolverlo, un
    // `AuthService` sin `token()` tiraba las 46 pruebas del componente de una.
    expect(() => montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) })).not.toThrow();
    const romper = { ...cajaSock, connect: () => { throw new Error('sin socket'); } };
    TestBed.resetTestingModule();

    TestBed.configureTestingModule({
      imports: [FinanzasCajaGeneralComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: CashLedgerService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }), token: () => null } },
        { provide: CajaSocketService, useValue: romper },
      ],
    });
    const fx = TestBed.createComponent(FinanzasCajaGeneralComponent);
    expect(() => fx.detectChanges()).not.toThrow();
    expect(fx.componentInstance.pendientes().length).toBe(1);
  });

  // ── 14 · CS.3 · AUTORRELLENO DE LA CAPTURA DESDE CAOS ────────────────────────────────────────
  //
  // Pedido: en Caja General (captura) autorellenar con CAOS; lo pendiente, con arqueo. El movimiento
  // de CAOS trae el conteo de la máquina → precarga el arqueo; el monto sale de ahí; se guarda con
  // origen_tipo='caos'. Las dos fuentes (CAOS/Kepler) son excluyentes en UNA captura.

  const CAOS_DEP = {
    origen_ref: 'AST700-19758|1420', external_id: 1420, device: 'AST700-19758',
    tipo: 'ingreso' as const, type_label: 'Deposito', occurred_at: '2026-09-24T10:00:00-06:00',
    fecha_valor: '2026-09-24', sucursal: '00', user_external: 'Vendedor (006) - VENTAS', ref: 'rd28',
    monto: 1300, denominaciones: [{ denominacion: 500, piezas: 2 }, { denominacion: 100, piezas: 3 }],
  };

  it('CS.3.7 — elegir un movimiento de CAOS lo pone APARTE; la reja arranca en cero y el monto sale del cajero', () => {
    montar();
    comp.abrirCaptura();
    comp.elegirCaos({ value: CAOS_DEP } as any);

    expect(comp.caosElegido()?.origen_ref).toBe('AST700-19758|1420');
    expect(comp.f().tipo).toBe('ingreso');
    expect(comp.f().sucursal).toBe('00');
    // El efectivo de la máquina va APARTE (denominacionesCajero), NO en la reja: queda VACIA.
    expect(comp.piezasDe(den(500))).toBeNull();
    expect(comp.aporteCajero()).toBe(1300);   // 500×2 + 100×3 = 1300
    expect(comp.f().monto).toBe(1300);        // monto = aporte del cajero + reja (0)
    // El arqueo (el del cajero) YA cuadra → no falta desglose ni descuadra.
    expect(comp.bloqueos()).not.toContain('falta_desglose');
    expect(comp.bloqueos()).not.toContain('arqueo_no_cuadra');
  });

  it('guardar con origen CAOS manda origen_tipo="caos" y origen_ref=device|external_id', () => {
    montar();
    comp.abrirCaptura();
    comp.elegirCaos({ value: CAOS_DEP } as any);
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'VENTAS');
    comp.setF('glosa', 'deposito de ruta 28');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    expect(comp.bloqueos()).toEqual([]);
    comp.guardar();

    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body['origen_tipo']).toBe('caos');
    expect(body['origen_ref']).toBe('AST700-19758|1420');
    // El monto va del conteo; no viaja monto_contado (CAOS no ancla a un documento Kepler).
    expect(body['monto']).toBe(1300);
    expect(body['monto_contado']).toBeUndefined();
  });

  it('[negativa] las dos fuentes son EXCLUYENTES: elegir CAOS suelta el cobro de Kepler', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    expect(comp.cobroElegido()).not.toBeNull();

    comp.elegirCaos({ value: CAOS_DEP } as any);
    expect(comp.caosElegido()).not.toBeNull();
    expect(comp.cobroElegido()).toBeNull(); // no quedan dos orígenes

    // Y al revés: tomar un documento suelta CAOS.
    comp.capturarDesde(GASTO_TRABADO);
    expect(comp.caosElegido()).toBeNull();
  });

  it('la morralla se suma a lo precargado de CAOS: "lo pendiente" se cuenta a mano', () => {
    montar();
    comp.abrirCaptura();
    comp.elegirCaos({ value: CAOS_DEP } as any);
    comp.setMorralla(15.5);
    expect(comp.f().monto).toBe(1315.5);
  });

  // ── CS.3.1c · CAOS ENTRA SOLO A LA BANDEJA + ARQUEO BLOQUEADO ──────────────────────────────
  it('CS.3.7 — capturar desde la bandeja pone el efectivo de la máquina APARTE; la reja arranca en cero', () => {
    montar({ caosCapturables: vi.fn(() => of({ rows: [CAOS_DEP], limit: 100, has_more: false, desde: '2026-09-24' })) });
    // ⛔ Los movimientos del cajero SIN CONCILIAR ya no se listan en la bandeja: son el MISMO
    // efectivo que la caja general de Kepler (`c45='0011'`), y listarlos sueltos invitaba a
    // capturarlos como asiento propio = doble conteo. La captura desde el cajero sigue viva para
    // el que SÍ se concilió (llega pegado a su fila de Kepler como `caos_match`).
    comp.capturarDesdeCaos(CAOS_DEP);
    expect(comp.caosElegido()?.origen_ref).toBe('AST700-19758|1420');
    // El efectivo de la máquina va APARTE, no en la reja: la reja queda VACIA (para la diferencia).
    expect(comp.piezasDe(den(500))).toBeNull();
    expect(comp.hayCajero()).toBe(true);
    expect(comp.aporteCajero()).toBe(1300);
    expect(comp.f().monto).toBe(1300);   // monto = aporte del cajero + reja (0)
  });

  it('CS.3.7 — el arqueo de la máquina va APARTE y la reja queda EDITABLE para la diferencia', async () => {
    const fx = await capturaEnPantalla();
    comp.elegirCaos({ value: CAOS_DEP } as any);
    fx.detectChanges();
    const piezas = inputsPieza(fx);
    const denoms = piezas.filter((i) => !i.classList.contains('cg-morralla-in'));
    const morralla = piezas.find((i) => i.classList.contains('cg-morralla-in'))!;
    // ⚠️ `[CG.38]` Eran 5 (los billetes); hoy son 12 (6 billetes + 6 monedas, con el de $1,000 desde el 16-oct). Lo que se afirma
    // —que la reja queda EDITABLE porque es la diferencia— no cambió.
    expect(denoms.length).toBe(12);
    expect(denoms.every((i) => !i.readOnly)).toBe(true);  // editables: la reja es la DIFERENCIA
    expect(morralla.readOnly).toBe(false);
    expect(comp.hayCajero()).toBe(true);                     // el cajero se muestra aparte
  });

  // ── CS.3.4 · EL DETECTOR: "ya se agregaron 20 mil del cajero" + agregá lo restante ──────────
  const CANDIDATO = { ...CAOS_DEP, score: 120, motivos: ['mismo día', 'monto exacto'], confianza: 'alta' as const };

  it('CS.3.4 — buscar en el cajero PROPONE candidatos para el gasto', () => {
    montar({ caosCandidatos: vi.fn(() => of({ rows: [CANDIDATO], fecha: '2026-09-24', datos_al: null })) });
    comp.abrirCaptura();
    comp.setF('beneficiario', 'CUERITOS LUPITA');
    comp.buscarEnCajero();
    expect(comp.caosSugeridos().length).toBe(1);
    expect(svc['caosCandidatos']).toHaveBeenCalled();
  });

  it('CS.3.7 — vincular un retiro pone su efectivo APARTE (no en la reja) y lo FUSIONA al guardar', () => {
    montar({ caosCandidatos: vi.fn(() => of({ rows: [CANDIDATO], fecha: '2026-09-24', datos_al: null })) });
    comp.abrirCaptura();
    comp.setF('tipo', 'gasto');
    comp.setF('sucursal', '00');
    comp.buscarEnCajero();
    comp.vincularCaos(comp.caosSugeridos()[0] as any);
    // El efectivo del cajero va APARTE; la reja NO se toca (queda VACIA, para la diferencia).
    expect(comp.piezasDe(den(500))).toBeNull();
    expect(comp.aporteCajero()).toBe(1300);
    expect(comp.f().monto).toBe(1300);   // monto = cajero + reja
    // El arqueo que va al servidor FUSIONA cajero + reja, para que cuadre con el monto (assertArqueo).
    expect(comp.denominacionesParaGuardar().reduce((a, d) => a + d.denominacion * d.piezas, 0)).toBe(1300);
    // Sin desglose tecleado, el arqueo YA cuadra (el del cajero) → no bloquea.
    comp.setF('kepler_cuenta', '201'); comp.setF('kepler_concepto', '001'); comp.setF('glosa', 'pago a cueritos');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    expect(comp.bloqueos()).toEqual([]);
    comp.guardar();
    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const links = body['caos_links'] as Array<{ external_id: number }>;
    expect(links.length).toBe(1);
    expect(links[0].external_id).toBe(1420);
    // El arqueo enviado incluye el efectivo del cajero (para que el servidor cuadre).
    const dens = body['denominaciones'] as Array<{ denominacion: number; piezas: number }>;
    expect(dens.reduce((a, d) => a + d.denominacion * d.piezas, 0)).toBe(1300);
  });

  it('[negativa] soltar un retiro vinculado RESTA su efectivo del arqueo', () => {
    montar({ caosCandidatos: vi.fn(() => of({ rows: [CANDIDATO], fecha: '2026-09-24', datos_al: null })) });
    comp.abrirCaptura();
    comp.buscarEnCajero();
    comp.vincularCaos(comp.caosSugeridos()[0] as any);
    expect(comp.f().monto).toBe(1300);
    comp.desvincularCaos(1420);
    expect(comp.f().monto).toBe(0);            // el efectivo del cajero se fue con el enlace
    expect(comp.caosVinculados().length).toBe(0);
  });

  /**
   * ⛔ `[CG.70]` **El cajero se nombra UNA vez.** Reportado por Edgar mirando la pantalla:
   * *"repetiste lo de caos dos veces"*.
   *
   * Había dos paneles —el detector de CS.3.4 y la mención aparte de CS.3.7— cada uno con su
   * recuadro y los dos rotulados `Del cajero (CAOS)`. Sus condiciones **no son excluyentes**:
   * `!caosElegido()` y `hayCajero()` son verdaderas a la vez en el camino normal (anclar un cobro
   * de Kepler → buscar → vincular un retiro), que es justo el que este test reproduce.
   *
   * ⚠️ La cuenta va contra el **texto** del apartado, no contra `strong`/`label`: lo que se afirma
   * es que la frase no aparezca dos veces, y amarrarla a una etiqueta concreta deja pasar la
   * repetición si alguien la vuelve a poner con otro elemento.
   */
  it('⛔ [CG.70] el apartado del arqueo nombra al cajero UNA sola vez, con y sin efectivo vinculado', async () => {
    const fx = montar({ caosCandidatos: vi.fn(() => of({ rows: [CANDIDATO], fecha: '2026-09-24', datos_al: null })) });
    comp.abrirCaptura();
    fx.detectChanges();
    await Promise.resolve();
    fx.detectChanges();

    const veces = () => {
      const ap = fx.nativeElement.querySelector('.cg-ap-arqueo') as HTMLElement | null;
      expect(ap, 'no hay apartado de arqueo que medir').not.toBeNull();
      return (ap!.textContent ?? '').match(/[Dd]el cajero \(CAOS\)/g)?.length ?? 0;
    };
    const paneles = () => fx.nativeElement.querySelectorAll('.cg-ap-arqueo .cg-caja-aparte').length;

    // (a) Sin nada del cajero: el panel está —es la puerta para buscar retiros— y se nombra una vez.
    expect(comp.hayCajero()).toBe(false);
    // ⚠️ El mensaje nombra las DOS fallas posibles: la primera redacción decía sólo "ya se
    // repetía" y la mutación que hizo desaparecer el panel disparó justo acá — con un texto que
    // mandaba a buscar una repetición que no existía.
    expect(veces(), 'sin efectivo del cajero el rótulo debe estar UNA vez: 0 = se perdió el panel, 2 = se repite').toBe(1);
    expect(paneles(), 'sin efectivo del cajero debe haber UN panel: 0 = no hay puerta para buscar retiros').toBe(1);
    // Y la búsqueda sigue a mano: la fusión no se llevó el control (era lo único de CS.3.4).
    const botones = Array.from(fx.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(botones.some((b) => /buscar retiros/i.test(b.textContent ?? '')),
      'se perdió el botón de buscar retiros').toBe(true);

    // (b) Con un retiro vinculado —las DOS condiciones verdaderas, el caso del reporte—: sigue una.
    comp.buscarEnCajero();
    comp.vincularCaos(comp.caosSugeridos()[0] as any);
    fx.detectChanges();
    expect(comp.hayCajero()).toBe(true);
    expect(comp.caosElegido()).toBeNull();
    expect(veces(), 'el rótulo del cajero aparece dos veces').toBe(1);
    expect(paneles(), 'dos recuadros para el mismo asunto').toBe(1);
    // El monto del cajero sigue dicho (la fusión no lo tiró al unir los dos rótulos).
    expect((fx.nativeElement.querySelector('.cg-ap-arqueo') as HTMLElement).textContent)
      .toContain(comp.money(comp.aporteCajero()));
  });

  // ── CS.3.13 · VENTA A CRÉDITO (cliente de crédito) ──────────────────────────────────────────
  it('CS.3.13 — capturar un cobro de cliente de crédito auto-rellena «venta a crédito» = el total', () => {
    montar();
    comp.capturarDesde(COBRO_CREDITO);
    expect(comp.clienteCredito()).toBe(true);
    expect(comp.ventaCredito()).toBe(1000);        // todo a crédito, auto-rellenado
    expect(comp.f().monto).toBe(1000);             // monto = efectivo(0) + crédito(1000)
  });

  it('CS.3.13 — toda la venta a crédito (sin efectivo) NO se bloquea: el crédito explica el total', () => {
    montar();
    comp.capturarDesde(COBRO_CREDITO);
    expect(comp.bloqueos()).not.toContain('falta_desglose');
    expect(comp.bloqueos()).not.toContain('monto_invalido');
    expect(comp.bloqueos()).not.toContain('arqueo_no_cuadra');
  });

  it('CS.3.13 — editable: bajar el crédito y contar efectivo mantiene efectivo + crédito = total', () => {
    montar();
    comp.capturarDesde(COBRO_CREDITO);
    comp.setVentaCredito(300);                      // 300 a crédito
    comp.setPiezas(den(500), 1); comp.setPiezas(den(200), 1); // 700 en efectivo
    expect(comp.f().monto).toBe(1000);             // 700 efectivo + 300 crédito
    expect(comp.bloqueos()).not.toContain('arqueo_no_cuadra');
  });

  it('CS.3.13 — un cobro de cliente SIN crédito no auto-rellena', () => {
    montar();
    comp.capturarDesde({ ...COBRO_CREDITO, cliente_credito: false });
    expect(comp.clienteCredito()).toBe(false);
    expect(comp.ventaCredito()).toBe(0);
  });

  it('CS.3.13 — guardar manda venta_credito', () => {
    montar();
    comp.capturarDesde(COBRO_CREDITO);
    comp.setF('glosa', 'cobro ruta a credito');
    // [CG.160] Captura manual: sin documento de Kepler hay que decir por que. El servidor lo
    // exige desde [CG.124]; antes la pantalla no tenia donde escribirlo y chocaba con un 400.
    comp.sinDocumentoMotivo.set('cobranza de ruta sin documento en Kepler');
    expect(comp.bloqueos()).toEqual([]);
    comp.guardar();
    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body['venta_credito']).toBe(1000);
  });

  // ── [CG.72] EL KPI NO CUENTA LOS CANCELADOS, Y LO DECLARA ─────────────────────────────────
  //
  // Encontrado en producción corriendo la pantalla: se guardó un movimiento de $20, se canceló, y
  // el encabezado del libro siguió publicando ese gasto ($131,080 vs $131,060 reales). El importe
  // lo arregla el servidor; lo que se prueba acá es que la pantalla EXPLIQUE la diferencia —
  // porque la lista sí muestra los cancelados y, sin el aviso, el encabezado se lee como un error.

  it('⭐ [CG.72] la tira declara la parte cancelada, que NO está en los importes', () => {
    montar();
    comp.kpiRaw.set({ movimientos: 3, ingresos: 0, gastos: 131060, depositos: 0, cancelados: 1, monto_cancelado: 20 });
    const tira = comp.kpis();
    const movs = tira.find((i) => /movimientos/i.test(i.label))!;
    expect(movs.value).toBe('3');                       // cuenta TODO: describe la lista
    expect(movs.sub, 'no dice nada de los cancelados').toBeTruthy();
    expect(movs.sub).toContain('1 cancelado');
    expect(movs.sub).toContain('20');
    expect(movs.sub).toMatch(/fuera de los importes/i); // y dice POR QUÉ no cuadra con la suma
    // El importe es el del servidor, sin recalcular: la pantalla no arbitra el dinero.
    expect(tira.find((i) => /gastos/i.test(i.label))!.value).toContain('131,060');
  });

  it('[CG.72] [negativa] sin cancelados NO se dibuja un "0 cancelados"', () => {
    // Un aviso permanente que casi siempre dice cero entrena a no leer los avisos.
    montar();
    comp.kpiRaw.set({ movimientos: 2, ingresos: 500, gastos: 0, depositos: 0, cancelados: 0, monto_cancelado: 0 });
    expect(comp.kpis().find((i) => /movimientos/i.test(i.label))!.sub).toBeUndefined();
  });

  it('[CG.72] el plural se dice bien con más de uno', () => {
    montar();
    comp.kpiRaw.set({ movimientos: 9, ingresos: 0, gastos: 100, depositos: 0, cancelados: 3, monto_cancelado: 75.5 });
    expect(comp.kpis().find((i) => /movimientos/i.test(i.label))!.sub).toContain('3 cancelados');
  });

  // ── [CG.71] EL SALDO DE LA CAJA SE VE ─────────────────────────────────────────────────────
  //
  // Pedido: "hay que agregar un apartado para ver el saldo actual de la caja chica". No faltaba
  // el dato: `cargarSaldo()` lo pedía en SIETE momentos y `textoSaldoUI` lo traducía — y la
  // plantilla no lo usaba ni una vez. Estas pruebas van contra el DOM a propósito: un test que
  // llame al computado pasa verde con la pantalla muda, que es exactamente lo que había.

  const CORTE_VIVO = { id: 'c1', folio: 'CC-2026-00007', fondo_inicial: 500, ya_reconto: false };

  it('⭐ [CG.71] el saldo se PINTA en la barra, sin un clic', async () => {
    const fx = montar({
      saldo: vi.fn(() => of({
        ...SALDO, saldo: 1300, saldo_oculto: false, sin_corte_abierto: false,
        corte_abierto: CORTE_VIVO,
      })),
    });
    fx.detectChanges();
    await Promise.resolve();
    fx.detectChanges();

    const el = fx.nativeElement.querySelector('.cg-bar .cg-saldo') as HTMLElement | null;
    expect(el, 'el saldo no está en la barra: se calculaba y no se pintaba').not.toBeNull();
    expect(el!.textContent).toContain('1,300');
    expect(el!.textContent).toContain('CC-2026-00007');
    // ⚠️ Con la jornada CERRADA: "saldo actual" que exige desplegar un panel no es actual.
    expect(comp.jornadaAbierta(), 'el saldo se ve sólo si se abre la jornada').toBe(false);
  });

  it('⛔ [CG.71] [negativa] a quien captura NO se le dibuja un número: se DECLARA que está oculto', async () => {
    // `[CG.19]`: el arqueo es ciego. Lo que el servidor retiene, la pantalla lo dice —nunca lo
    // rellena con 0— y tampoco miente diciendo que no hay corte.
    const fx = montar({
      saldo: vi.fn(() => of({
        ...SALDO, saldo: null, saldo_oculto: true, sin_corte_abierto: false,
        corte_abierto: CORTE_VIVO,
      })),
    });
    fx.detectChanges();
    await Promise.resolve();
    fx.detectChanges();

    const txt = (fx.nativeElement.querySelector('.cg-bar .cg-saldo') as HTMLElement)?.textContent ?? '';
    expect(txt).toContain('oculto');
    expect(txt).toContain('CC-2026-00007');
    expect(txt).not.toContain('sin corte abierto');
    expect(txt).not.toMatch(/\$\s?0([.,]00)?\b/);
  });

  // ── 18 · [CG.26] EL CIERRE DE LA JORNADA ──────────────────────────────────────────────────
  //
  // El bloque «Arqueo final del día» YA existía y colgaba de `@if (corteAbierto())`. En prod hay
  // CERO cortes, así que no lo vio nunca nadie. Estas pruebas fijan las dos cosas que cambian:
  // que se pinte SIN corte, y que el cajero muestre sus SEIS tipos y no dos.

  /** El panel, ya en el DOM. Se acota al contenedor: `money()` de los KPIs colisiona con el de acá. */
  function panelCierre(fx: ReturnType<typeof montar>): string {
    const el = fx.nativeElement.querySelector('.cg-conc');
    return el ? el.innerHTML : '';
  }

  it('⭐ [negativa] el cierre del día se pinta AUNQUE no haya corte abierto', () => {
    // Éste es exactamente el estado de producción: sin cortes. Antes dejaba el panel invisible.
    const fx = montarJornada({
      cortes: vi.fn(() => of({ rows: [] })),
      saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })),
    });
    expect(comp.corteAbierto()).toBeNull();

    const panel = panelCierre(fx);
    expect(panel).toContain('Cierre de la jornada');
    expect(panel).toContain('Caja general');
    expect(panel).toContain('Cajero');
  });

  it('el cajero muestra sus SEIS tipos, no sólo depósito y dispensación', () => {
    const fx = montarJornada();
    const panel = panelCierre(fx);
    // Los dos que la conciliación vieja ignoraba y que mueven la bóveda de verdad.
    expect(panel).toContain('Dotar');
    expect(panel).toContain('Vaciar Stocks');
    expect(panel).toContain('Deposito');
    expect(panel).toContain('Dispensar');
  });

  it('el neto del cajero se rotula «movimiento», NUNCA «saldo» — y DICE de qué', () => {
    // No es cosmética: el flujo acumulado da negativo porque el efectivo anterior al feed no se
    // conoce. Publicarlo como saldo sería publicar un número que no existe.
    //
    // ⛔ [CG.112] Esta prueba fijaba la cadena literal «Movimiento del dia», y ESE era el
    // problema que reportó Edgar: la columna del libro usaba el MISMO rótulo con otra cifra
    // (−$6,435.79 contra $38,550.00), las dos a la vista. Ahora cada columna nombra lo suyo y la
    // prueba fija el INVARIANTE —movimiento, nunca saldo— más la desambiguación.
    const fx = montarJornada();
    const panel = panelCierre(fx);
    expect(panel).toContain('Movimiento de la bóveda');
    expect(panel).toContain('Movimiento del libro');
    expect(panel.toLowerCase()).not.toContain('saldo del cajero');
    // Los dos rótulos tienen que ser DISTINTOS: si vuelven a ser iguales, vuelve el defecto.
    expect(panel).not.toContain('Movimiento del dia');
  });

  /**
   * ⭐⭐ `[CG.139]` **UN MOVIMIENTO, DOS CAJAS — el selector cambia el DINERO, no las filas.**
   *
   * Edgar, tras verlo en pantalla: *"si entró a CAOS no se considera en caja general"*, y después,
   * corrigiéndome el modelo: *"se asocia a un movimiento de CAOS, pero el dinero que entró a CAOS
   * y el dinero que entró a caja chica es diferente. Se engloban en movimiento pero se separan en
   * dinero"*.
   *
   * El fixture reproduce el caso real de prod: un cobro de ruta de **$15,542** del que la máquina
   * se tragó **$15,510 en billetes** y al cajón llegaron **$32 de morralla**, más un depósito que
   * un vendedor hizo DIRECTO al cajero (100% bóveda, 0 al cajón).
   */
  describe('[CG.139] el reparto entre el cajón y la bóveda', () => {
    const CON_REPARTO = {
      ...ARQUEO,
      movimientos_del_dia: [
        // El que se PARTE. Esto es lo que una bandera por movimiento no puede representar.
        {
          id: 'm1', folio: 'CI-1', hora: '10:00', tipo: 'ingreso' as const, monto: 15542,
          en_boveda: 15510, en_cajon: 32, beneficiario: 'Ruta 006', documento: null,
          concepto: 'ABONO A CLIENTES', cuenta: '115', estado: 'registrado',
          origen: 'cobro', quien: 'cajera',
        },
        // El que entró DIRECTO a la máquina: nunca tocó el cajón.
        {
          id: 'm2', folio: 'CI-2', hora: '11:00', tipo: 'ingreso' as const, monto: 20000,
          en_boveda: 20000, en_cajon: 0, beneficiario: 'Vendedor (003)', documento: 'CAOS #1590',
          concepto: 'ABONO A CLIENTES', cuenta: '115', estado: 'registrado',
          origen: 'caos', quien: 'sistema',
        },
        // Un gasto pagado con efectivo del cajón, para que el pie tenga los dos lados.
        {
          id: 'm3', folio: 'CG-1', hora: '12:00', tipo: 'gasto' as const, monto: 500,
          en_boveda: 0, en_cajon: 500, beneficiario: 'Papelería', documento: null,
          concepto: 'PAPELERIA', cuenta: '607', estado: 'registrado',
          origen: null, quien: 'cajera',
        },
      ],
    };

    /**
     * `[CG.128]` Abre la jornada EN «Movimientos», que es donde vive el diario desde que se midió
     * en la pantalla viva que pesaba **1,058px de los 2,023** de «Hoy» — el 55 %.
     * ⚠️ El patch de datos NO se pierde: estas pruebas necesitan `CON_REPARTO`, y sin él la
     * tabla queda vacía y la prueba pasaría a medir otra cosa.
     */
    const montar = () => montarJornadaEn('movimientos', { arqueoDia: vi.fn(() => of(CON_REPARTO as never)) });

    it('⭐ en «Caja general» suma SÓLO la morralla del cobro, no sus billetes', () => {
      montar();
      expect(comp.dondeEntro()).toBe('cajon');   // arranca en el tema de la pantalla
      // 32 de morralla + 0 del depósito directo. ⛔ Si sumara los montos enteros daría 35,542:
      // $35,510 que están dentro de una máquina, publicados como caja general.
      expect(comp.totalHistorial().ingresos).toBe(32);
      expect(comp.totalHistorial().gastos).toBe(500);
      expect(comp.totalHistorial().neto).toBe(-468);
    });

    it('⭐ en «Se fue a CAOS» suma los billetes, incluido el del cobro que se partió', () => {
      montar();
      comp.dondeEntro.set('boveda');
      expect(comp.totalHistorial().ingresos).toBe(35510);   // 15,510 + 20,000
      expect(comp.totalHistorial().gastos).toBe(0);
    });

    it('en «Todo» vuelve el monto entero, y las tres vistas cierran: cajón + bóveda = todo', () => {
      montar();
      comp.dondeEntro.set('todo');
      const todo = comp.totalHistorial().ingresos;
      expect(todo).toBe(35542);
      comp.dondeEntro.set('cajon');
      const cajon = comp.totalHistorial().ingresos;
      comp.dondeEntro.set('boveda');
      // ⭐ La conservación, del lado del front: lo que se reparte no se crea ni se pierde.
      expect(cajon + comp.totalHistorial().ingresos).toBe(todo);
    });

    it('⛔ [negativa] el selector NO esconde renglones: el cobro sale en las TRES vistas', () => {
      // Esconderlo en «Caja general» sería tan falso como mostrarlo entero: el cobro ESTÁ en las
      // dos cajas. Si alguien vuelve a filtrar filas, esta cuenta cambia y la prueba se cae.
      // `[CG.128]` Lo que esta prueba cuida no cambió: que el selector de CAJA cambie el
      // importe y NO esconda renglones. Lo que cambió es dónde vive el diario.
      const fx = montar();
      for (const v of ['cajon', 'boveda', 'todo'] as const) {
        comp.dondeEntro.set(v);
        fx.detectChanges();
        expect(fx.nativeElement.textContent).toContain('CI-1');
      }
    });

    it('⛔ [negativa] sin el reparto del API no dibuja un cero: cae al monto entero', () => {
      // Un deploy parcial (API vieja, front nuevo) no manda `en_cajon`. Un 0 ahí afirmaría que al
      // cajón no llegó nada, que es una afirmación — y falsa. Se muestra lo que sí se sabe.
      montarJornada({
        arqueoDia: vi.fn(() => of({
          ...ARQUEO,
          movimientos_del_dia: [{
            ...CON_REPARTO.movimientos_del_dia[0], en_boveda: undefined, en_cajon: undefined,
          }],
        } as never)),
      });
      expect(comp.totalHistorial().ingresos).toBe(15542);
    });
  });

  it('⛔ [negativa] sin cajero en la sucursal NO pinta ceros: pinta el motivo', () => {
    const fx = montarJornada({
      arqueoDia: vi.fn(() => of({
        ...ARQUEO, sucursal: '03', cajero: null,
        no_medido: ['El cajero (CAOS) es un único dispositivo en oficinas: la sucursal 03 no tiene cajero que cuadrar.'],
      })),
    });
    const panel = panelCierre(fx);
    expect(panel).toContain('Sin cajero que cuadrar');
    expect(panel).toContain('no tiene cajero que cuadrar');

    // ⚠️ La aserción se acota a la COLUMNA DEL CAJERO, no al panel: "Movimiento del día" es
    // también el total de la columna de caja general, que acá SÍ tiene que estar. Sobre el panel
    // entero esta prueba fallaba por el rótulo de al lado — el mismo error que ya había costado
    // una prueba en el bloque del arqueo ("$1,000" aparecía en la tira de KPIs).
    const cols = fx.nativeElement.querySelectorAll('.cg-conc-col');
    const colCajero: string = cols[cols.length - 1].innerHTML;
    // Lo que NO puede pasar: que un cajero ausente se vea como un cajero quieto.
    expect(colCajero).not.toContain('Movimiento del dia');
    expect(colCajero).not.toContain('$');
  });

  it('⛔ [negativa] lo NO MEDIDO se pinta, no se esconde', () => {
    const fx = montarJornada();
    const panel = panelCierre(fx);
    expect(panel).toContain('no publica cu');   // "...no publica cuánto efectivo tiene adentro"
    expect(fx.nativeElement.querySelector('.cg-conc-nm')).toBeTruthy();
  });

  it('un tipo de cajero DESCONOCIDO se pinta aparte y con aviso', () => {
    const fx = montarJornada({
      arqueoDia: vi.fn(() => of({
        ...ARQUEO,
        cajero: {
          ...ARQUEO.cajero!,
          por_tipo: [...ARQUEO.cajero!.por_tipo, { type_id: 99, etiqueta: '(tipo 99 sin etiqueta)', movimientos: 1, monto: 500, desconocido: true }],
          tipos_desconocidos: [{ type_id: 99, etiqueta: '(tipo 99 sin etiqueta)', monto: 500 }],
        },
        no_medido: [...ARQUEO.no_medido, 'El cajero reportó un tipo de movimiento que no conocemos: está listado aparte y NO se sumó a ninguna pierna.'],
      })),
    });
    const panel = panelCierre(fx);
    expect(panel).toContain('tipo 99');
    expect(panel).toContain('NO se sumo a ninguna pierna');
  });

  it('⛔ [negativa] sin corte abierto el esperado NO aparece — el arqueo ciego sigue puesto', () => {
    const fx = montar({
      cortes: vi.fn(() => of({ rows: [] })),
      saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true, saldo: null })),
    });
    const html: string = fx.nativeElement.innerHTML + document.body.innerHTML;
    expect(html).not.toContain('Esperado en caja general');
  });

  it('⛔ [negativa] si la medición falla, el día NO se pinta en cero: se declara sin medir', () => {
    const fx = montarJornada({ arqueoDia: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    expect(comp.arqueo()).toBeNull();
    expect(comp.arqueoSinMedir()).toBe(true);

    const panel = panelCierre(fx);
    expect(panel).toContain('No se pudo medir la jornada');
    // Lo que no puede pasar: que un error de red se lea como una jornada sin movimiento.
    expect(panel).not.toContain('Movimiento del dia');
  });

  it('cambiar la jornada vuelve a pedirla con esa fecha', () => {
    montar();
    comp.setArqueoFecha('2026-09-08');
    expect(comp.arqueoFecha()).toBe('2026-09-08');
    expect(svc['arqueoDia'].mock.calls.at(-1)?.[0]).toMatchObject({ fecha: '2026-09-08', sucursal: '00' });
  });

  it('una fecha vacía NO dispara una consulta con la fecha en blanco', () => {
    montar();
    const antes = svc['arqueoDia'].mock.calls.length;
    comp.setArqueoFecha('');
    expect(svc['arqueoDia'].mock.calls.length).toBe(antes);
  });

  // ── 19 · [CG.27-B.1/B.3] LOS QUE REPITEN Y NADIE DECLARO SU CUENTA ────────────────────────
  //
  // Es el 69 % de los clics de la caja y no había por dónde verlo. Lo que estas pruebas fijan es
  // que el CONTADOR esté siempre a la vista (una lista escondida no se trabaja) y que las dos
  // ausencias distintas —"no propone" y "no hay de dónde proponer"— no se pinten igual.

  it('el contador va SIEMPRE visible, aunque la lista esté plegada', () => {
    // `[CG.123]` Vive en «Pendientes»: no es la jornada de hoy, es trabajo que espera.
    const fx = montarJornadaEn('pendientes');
    expect(comp.recAbierto()).toBe(false);          // nace plegada: son 57 filas

    const html: string = fx.nativeElement.innerHTML;
    expect(html).toContain('Repiten y nadie declaro su cuenta');
    expect(html).toContain('57 de 58');
    expect(html).toContain('5688 pagos');
  });

  it('el contador separa "con propuesta" de "sin de dónde proponer": son dos trabajos distintos', () => {
    // Uno es confirmar lo que la contabilidad ya hizo; el otro es decidir de cero. Medido en prod:
    // 3 y 54. Juntarlos en un solo número escondería que casi nadie tiene propuesta.
    montar();
    const t = comp.textoRecurrentes(RECURRENTES);
    expect(t).toContain('3 con propuesta');
    expect(t).toContain('54 sin de d');
    expect(t).toContain('11 dejaron de cobrar');
  });

  it('⛔ [negativa] si la medición falla NO dice "no hay ninguno": dice que no se midió', () => {
    const fx = montarJornada({ recurrentesSinRegla: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    expect(comp.recurrentes()).toBeNull();
    const html: string = fx.nativeElement.innerHTML;
    expect(html).toContain('Sin medir');
    expect(html).not.toContain('sin de d');
  });

  it('⛔ [negativa] cero sin regla se dice como "ya está todo declarado", no como lista vacía', () => {
    montar();
    const t = comp.textoRecurrentes({
      ...RECURRENTES,
      medido: { ...RECURRENTES.medido, sin_regla: 0, pagos_sin_regla: 0, caidos: 0 },
    });
    expect(t).toContain('ya tienen su cuenta declarada');
  });

  it('el CV decide qué se le puede proponer: fijo, variable o muy variable', () => {
    montar();
    const [caja, capitan, arturo] = RECURRENTES.rows;
    // CAPITAN DE MARCA, CV 0.36 → el importe casi no se mueve.
    expect(comp.esImporteProponible(capitan)).toBe(true);
    expect(comp.textoImporte(capitan)).toContain('fijo');
    // CAJA CHICA, CV 3.39 → la cuenta sí, el monto jamás.
    expect(comp.esImporteProponible(caja)).toBe(false);
    expect(comp.textoImporte(caja)).toBe('muy variable');
    expect(comp.textoImporte(arturo)).toBe('variable');
  });

  it('⛔ [negativa] un CV sin medir NO se pinta igual que un CV de cero', () => {
    // 0 significa "siempre el mismo importe", que es la señal más fuerte que hay acá. Pintarlo
    // como "sin medir" sería perder justo la mejor.
    montar();
    const base = RECURRENTES.rows[1];
    expect(comp.textoImporte({ ...base, cv_importe: null })).toBe('sin medir');
    expect(comp.textoImporte({ ...base, cv_importe: 0 })).toContain('fijo');
    expect(comp.esImporteProponible({ ...base, cv_importe: null })).toBe(false);
  });

  it('abrir la lista pinta las filas, con el par propuesto y su respaldo', async () => {
    const fx = montarJornadaEn('pendientes');
    comp.recAbierto.set(true);
    fx.detectChanges();
    await Promise.resolve();
    fx.detectChanges();

    const tabla: string = fx.nativeElement.querySelector('.cg-rec').innerHTML;
    expect(tabla).toContain('CAPITAN DE MARCA');
    expect(tabla).toContain('606-014 / 074');
    expect(tabla).toContain('447 antecedentes');
    // ⛔ La otra ausencia: no es que el motor no proponga, es que no hay de dónde.
    expect(tabla).toContain('Sin de donde proponer');
  });

  it('declarar desde la lista abre la captura con el beneficiario y el par ya puestos', () => {
    montar();
    comp.declararDesdeRecurrente(RECURRENTES.rows[1]);

    expect(comp.f().tipo).toBe('gasto');
    expect(comp.f().beneficiario).toBe('CAPITAN DE MARCA');
    // La propuesta viaja, para que la persona confirme en vez de teclear.
    expect(comp.f().kepler_cuenta).toBe('606-014');
    expect(comp.f().kepler_concepto).toBe('074');
  });

  it('⛔ [negativa] sin propuesta contable NO se inventa una cuenta', () => {
    montar();
    comp.declararDesdeRecurrente(RECURRENTES.rows[0]);   // el que no tiene historia

    expect(comp.f().beneficiario).toBe('GASTOS GENERALES CAJA CHICA MORELIA ABASTOS');
    expect(comp.f().kepler_cuenta).toBeNull();
    expect(comp.f().kepler_concepto).toBeNull();
  });

  // ── 20 · [CG.28] LA VENTANA TENIA PISO PERO NO TECHO ──────────────────────────────────────
  //
  // Medido en prod el 2026-09-30: con la ventana en 1 dia, la bandeja devolvia **7 filas y las 7
  // eran documentos mal fechados** (6 X-D-26 + 1 U-A-5, todas de diciembre). El filtro era
  // `fecha_valor >= desde` sin tope de arriba, asi que los unicos que pasaban un "ultimo dia"
  // eran justamente los del futuro: el ERP captura con 3 dias de mediana y ninguno legitimo
  // tiene `fecha_valor` de hoy.

  it('[CGA-A.43] la cola no manda ventana: la acota el servidor en el primer corte del libro', () => {
    // Antes arrancaba en «La jornada» (3 días) con un selector. Medido el 2026-10-20: desde el
    // primer corte del libro la cola es exacta (61 documentos) y los 3 días escondían 32.
    const movimientosPendientes = vi.fn(() => of({ ...VACIA, desde: '2026-10-01', ventana_dias: null, desde_motivo: 'relevo', relevo: '2026-10-12', saldados_por_control: 495 }));
    montar({ movimientosPendientes });
    const pedidos = movimientosPendientes.mock.calls as unknown as Array<[{ from?: string }]>;
    expect(pedidos.length).toBeGreaterThan(0);
    // NEGATIVA: si la pantalla volviera a mandar una ventana, el servidor dejaría de acotar en el relevo.
    for (const [q] of pedidos) expect(q.from).toBeUndefined();
    expect((comp as unknown as Record<string, unknown>)['opcionesVentana']).toBeUndefined();
    expect(comp.textoAlcance()).toContain('primer corte del libro');
    expect(comp.textoAlcance()).toContain('12/10/26');
    // [CGA-A.44] Arranca el 1 del mes del relevo y dice qué entra de la era Control.
    expect(comp.textoAlcance()).toContain('01/10/26');
    expect(comp.textoAlcance()).toContain('el Control no concilió');
  });

  it('[CGA-A.49] el alcance parte el total en la cola del libro y el rezago de Control', () => {
    // «Mi trabajo» y la campana cuentan SÓLO la del libro: sin partirlo, la responsable ve 54 allá
    // y 100 acá y no sabe cuál es el bueno (medido el 2026-10-20: 54 + 46 = 100).
    const cola = {
      del_libro: { n: 54, monto: 736378.53, mas_viejo: '2026-10-12' },
      rezago_control: { n: 46, monto: 737331.75, mas_viejo: '2026-10-02' },
    };
    montar({ movimientosPendientes: vi.fn(() => of({ ...VACIA, desde: '2026-10-01', ventana_dias: null, desde_motivo: 'relevo', relevo: '2026-10-12', cola })) });
    const t = comp.textoAlcance();
    expect(t).toContain('54 desde el 12/10/26 (primer corte del libro)');
    expect(t).toContain('46 del 01/10/26 al 11/10/26 que el Control no concilió');
  });

  it('[CGA-A.49] la antigüedad de un pendiente se cuenta contra el día de México', () => {
    montar({});
    const hoy = todayMx();
    const hace = (n: number) => { const d = new Date(`${hoy}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    expect(comp.diasPendiente(hoy)).toBe(0);
    expect(comp.diasPendiente(hace(4))).toBe(4);
    // NEGATIVA: lo fechado adelante no tiene antigüedad (lo declara `esFutura`), ni lo que no tiene fecha.
    expect(comp.diasPendiente(hace(-2))).toBeNull();
    expect(comp.diasPendiente(null)).toBeNull();
  });

  // ── [CG.51] El scroll: el historial se pliega, pero NO se esconde ─────────────────────────

  it('el historial arranca CERRADO: debajo del area de trabajo no hay 800px de archivo', () => {
    const fx = montarJornada();
    expect(comp.historialAbierto()).toBe(false);
    // La tabla del libro y la de los cortes no estan en el DOM mientras este cerrado.
    // ⚠️ ACOTADO A LA TIRA DEL LIBRO desde el 2026-10-16: la cola tiene ahora SU PROPIA tira
    // answer-first arriba (regla Q.1), asi que "no hay NINGUNA app-metric-strip" dejo de ser la
    // pregunta. Lo que esta prueba afirma -- que el archivo no cuelga 800px debajo del area de
    // trabajo -- no cambio; lo que cambio es que hay dos tiras y cada una tiene su clase.
    expect(fx.nativeElement.querySelector('app-metric-strip.cg-kpis-libro')).toBeNull();
    expect(fx.nativeElement.querySelector('.cg-kpi-h'),
      'el titulo del libro no deberia estar con el historial cerrado').toBeNull();
    // Y la de la cola SI esta: es el veredicto de lo que se esta mirando, no archivo.
    expect(fx.nativeElement.querySelector('app-metric-strip.cg-kpis-cola')).not.toBeNull();
  });

  it('cerrado NO es escondido: la cabecera dice el rango y cuanto hay adentro', () => {
    // `[CG.123]` El libro y los cortes son OTRO rango de fechas: viven en «Historial».
    const fx = montarJornadaEn('historial');
    const h: HTMLElement | null = fx.nativeElement.querySelector('.cg-historial-h');
    expect(h).not.toBeNull();
    // Plegar algo sin decir que tiene adentro lo vuelve indistinguible de que no exista.
    expect(h!.textContent).toContain('Historial');
    expect(h!.textContent).toContain('movimiento(s) en el libro');
    expect(h!.textContent).toContain('corte(s)');
    // Y es un <button> con su estado anunciado, no un <h2> con (click).
    expect(h!.tagName).toBe('BUTTON');
    expect(h!.getAttribute('aria-expanded')).toBe('false');
  });

  it('al abrirlo aparece el libro, y el aria-expanded lo acompana', () => {
    const fx = montarJornadaEn('historial');
    comp.historialAbierto.set(true);
    fx.detectChanges();
    expect(fx.nativeElement.querySelector('app-metric-strip')).not.toBeNull();
    expect(fx.nativeElement.querySelector('.cg-historial-h')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('⛔ [negativa] los mal fechados se DICEN, no se esconden', () => {
    const fx = montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, mal_fechados: { movimientos: 7, monto: 50796 },
      })),
    });
    expect(comp.malFechados()).toEqual({ movimientos: 7, monto: 50796 });

    const html: string = fx.nativeElement.innerHTML;
    expect(html).toContain('7 documento(s) del ERP');
    // Lo importante no es el numero: es que diga DONDE se arregla. Aca no se arreglan.
    expect(html).toContain('Kepler');
  });

  it('sin mal fechados no se pinta el aviso: un "0 mal fechados" es ruido', () => {
    const fx = montar({
      movimientosPendientes: vi.fn(() => of({ ...VACIA, mal_fechados: { movimientos: 0, monto: 0 } })),
    });
    expect(comp.malFechados()).toBeNull();
    expect(fx.nativeElement.innerHTML).not.toContain('fechados');
  });

  // ── 21 · [CG.29] JERARQUIA Y "DONDE RINDO CUENTAS" ────────────────────────────────────────
  //
  // El peor defecto de la pantalla era mio: el bloque se llamaba "Cierre de la jornada" y NO
  // TENIA UN SOLO BOTON. Prometia un acto y entregaba un informe. El mecanismo existia, pero
  // entraba por un "Abrir corte" gris y chico en medio de una linea de texto -- y nadie busca
  // "corte" cuando quiere rendir cuentas del dia.

  it('⭐ el cierre de la jornada TIENE la accion, y se llama como la gente la busca', () => {
    const fx = montarJornada({
      saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })),
    });
    const panel: string = fx.nativeElement.querySelector('.cg-conc').innerHTML;
    expect(panel).toContain('rendir cuentas');
    // Y NO se llama "corte", que es el nombre interno del mecanismo.
    expect(panel).not.toContain('Abrir corte');
  });

  it('⭐ [el gesto unico] sin corte abierto, rendir cuentas NO pide el fondo y cae en el conteo', () => {
    // El arqueo exigia abrir el corte a las 8am para poder cerrarlo a las 7pm. Nadie lo hacia:
    // hay CERO cortes en produccion. Aca el gesto es uno solo, en el momento natural.
    //
    // ⭐ `[CG.90.1]` Esta prueba EXIGIA el dialogo ("pide el fondo"), y ahora exige lo contrario.
    // Edgar: "lo unico que debe hacer el usuario es arquear, no debe rellenar nada" y, dos veces,
    // "sigue pidiendo el fondo inicial". El fondo de hoy es lo que se conto ayer: lo hereda el
    // servidor. Preguntarlo era pedir que alguien teclee un numero que el sistema ya tiene.
    montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
    comp.cerrarJornada();
    expect(comp.aperturaAbierta()).toBe(false);   // ⛔ NO se pregunta nada
    expect(svc['abrirCorte']).toHaveBeenCalled(); // se abre solo…
    expect(comp.cierreAbierto()).toBe(true);      // …y cae DERECHO en el conteo

    // Y viaja `undefined`, que es lo unico que dispara la herencia del servidor: con `null` el
    // fondo viajaria como un valor y `[CG.90]` no se activaria. Ya paso una vez.
    const body = (svc['abrirCorte'] as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(body['fondo_inicial']).toBeUndefined();
  });

  // ── `[CG.42]` El arreglo de `[CG.39]` era INALCANZABLE desde la pantalla ────────────────────
  //
  // `[CG.39]` volvio `fondo_inicial` nullable y enseno a `abrir()` a guardar NULL cuando llega
  // `undefined`. Pero el formulario arrancaba el signal en `0` y SIEMPRE mandaba un numero, asi
  // que `undefined` no se podia producir por la unica via real: cada apertura seguia afirmando
  // "la caja arranco vacia", ahora encima rotulada `fondo_origen='contado'`.
  //
  // Estas dos pruebas son la compuerta: la de abajo falla si alguien vuelve a precargar un cero.
  it('⭐ [CG.42] abrir sin tocar el fondo manda UNDEFINED, no 0 ("no se midio" != "esta vacia")', () => {
    montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
    comp.abrirApertura();
    expect(comp.fondoInicial()).toBeNull();   // el dialogo NO precarga un cero

    comp.abrirCorte();
    const body = (svc['abrirCorte'] as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(body['fondo_inicial']).toBeUndefined();
    expect(body['fondo_inicial']).not.toBe(0);
  });

  it('[negativa] si la persona SI escribe el fondo, ese numero viaja tal cual -- incluido el 0', () => {
    montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
    comp.abrirApertura();
    comp.fondoInicial.set(0);                 // contar y que de cero ES una medicion
    comp.abrirCorte();
    const body = (svc['abrirCorte'] as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(body['fondo_inicial']).toBe(0);
  });

  it('con corte abierto va derecho al conteo, sin volver a pedir el fondo', () => {
    // ⚠️ La fixture SALDO trae `corte_abierto: null`. Mi primera version decia "SALDO trae corte
    // abierto" en un comentario y montaba con el default: la prueba fallaba por la fixture, no
    // por el codigo. Un comentario no cambia lo que la fixture dice.
    montar({
      saldo: vi.fn(() => of({
        ...SALDO, sin_corte_abierto: false,
        corte_abierto: { id: 'c1', folio: 'CC-2026-00001', fondo_inicial: 500, ya_reconto: false },
      })),
    });
    comp.cerrarJornada();
    expect(comp.aperturaAbierta()).toBe(false);
    expect(comp.cierreAbierto()).toBe(true);
  });

  it('⛔ [negativa] si la apertura FALLA, la intencion NO queda colgada', () => {
    // Sin esto, el siguiente corte que alguien abriera por su cuenta saltaria al conteo solo.
    //
    // ⭐ `[CG.90.1]` Esta prueba vigilaba el mismo riesgo por la puerta del DIALOGO (cancelar la
    // apertura). Al quitar el dialogo, ese camino de limpieza desaparecio y el agujero se abrio
    // por el otro lado: `cerrarJornada()` pone la intencion y `abrirCorte()` solo la limpiaba en
    // el camino de EXITO. Un freno puesto para una puerta sirvio para la otra -- por eso se
    // reescribe en vez de borrarse cuando cambia el gesto.
    // La primera llamada falla; la segunda anda. Asi se ejerce el mismo componente en los dos
    // momentos -- `montar()` dos veces no se puede, TestBed ya quedo instanciado.
    const abrir = vi.fn()
      .mockImplementationOnce(() => throwError(() => ({ status: 500, error: {} })))
      .mockImplementation(() => of({ id: 'c1', folio: 'CC-1' }));
    montar({
      saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })),
      abrirCorte: abrir,
    });
    comp.cerrarJornada();                    // falla al abrir
    expect(comp.cierreAbierto()).toBe(false);

    // Y la siguiente apertura, hecha a proposito por alguien, NO debe saltar al conteo.
    comp.abrirApertura();
    comp.abrirCorte();
    expect(abrir).toHaveBeenCalledTimes(2);
    expect(comp.cierreAbierto()).toBe(false);
  });

  it('⛔ [negativa] sin saber si hay corte NO se ofrece rendir cuentas', () => {
    // Abrir un segundo corte sobre uno vivo es el peor final. Si no se pudo medir, se reintenta.
    const fx = montarJornada({ saldo: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    expect(comp.saldoSinMedir()).toBe(true);
    const panel: string = fx.nativeElement.querySelector('.cg-conc').innerHTML;
    expect(panel).toContain('Reintentar');
    expect(panel).not.toContain('rendir cuentas');
  });

  it('el subtitulo dice el estado de HOY, no la cobertura del catalogo', () => {
    montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
    expect(comp.subtituloJornada()).toContain('no rendiste cuentas');
  });

  it('⛔ [negativa] "sin medir" no se dice igual que "ya rendiste"', () => {
    montar({ saldo: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
    expect(comp.subtituloJornada()).toContain('no se pudo medir');
    expect(comp.subtituloJornada()).not.toContain('no rendiste cuentas');
  });

  /**
   * `[CG.30]` El subtitulo publicaba el TAMANO DE LA PAGINA como si fuera el trabajo pendiente.
   * Medido en prod: decia "31 de 100" teniendo 1,887 en esa caja y 12,793 en total.
   */
  it('el subtitulo dice el UNIVERSO, no el tamano de la pagina', () => {
    montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [GASTO_TRABADO], limit: 100, has_more: true, confirmables: 0, total: 1887,
      })),
    });
    expect(comp.subtituloJornada()).toContain('1,887 por confirmar');
    // ⛔ Lo que [CG.30] vigila sigue igual: el subtitulo NO puede publicar el tamano de la pagina
    // como si fuera el trabajo. Lo que cambio es donde vive el "de un clic".
    expect(comp.subtituloJornada()).not.toContain('100');
  });

  /**
   * `[CG.47]` El mismo hecho NO puede decirse dos veces en la misma pantalla. El subtitulo decia
   * "0 de las 100 que se ven son de un clic" mientras la cabecera de la bandeja decia "0 de 100
   * se confirman de un clic", a cinco centimetros. Es el defecto que [CG.30.1] arreglo y que
   * [CG.45] reintrodujo al mover la cifra a la seccion sin sacarla del subtitulo.
   */
  it('⛔ [CG.47] el subtitulo y la cabecera NO dicen el mismo hecho', () => {
    const fx = montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [GASTO_TRABADO], limit: 100, has_more: true, confirmables: 0, total: 1887,
      })),
    });
    // El subtitulo: el universo y el estado del dia. La cabecera: lo accionable.
    expect(comp.subtituloJornada()).not.toContain('de un clic');
    const head: string = fx.nativeElement.querySelector('.cg-bandeja-head').textContent;
    expect(head).toContain('de un clic');
    expect(head).not.toContain('1,887');
  });

  it('⛔ [negativa] sin total medido NO inventa un universo', () => {
    // API vieja: `total` ausente. Antes publicaba rows.length como si fuera el pendiente.
    montar({
      movimientosPendientes: vi.fn(() => of({ ...VACIA, rows: [GASTO_TRABADO], confirmables: 0 })),
    });
    const t = comp.subtituloJornada();
    // Lo que se vigila es que NO se afirme un universo que nadie midio. Antes caia a la frase
    // "N de las M que se ven", que es la de la seccion; ahora lo DECLARA (ADR-056).
    expect(t).toContain('Sin medir');
    expect(t).not.toMatch(/\d+ por confirmar/);
  });

  it('con un total chico lo dice igual, sin rodeos ni "de un clic"', () => {
    montar({
      movimientosPendientes: vi.fn(() => of({ ...VACIA, rows: [GASTO_TRABADO], confirmables: 1, total: 1 })),
    });
    // Antes habia una rama aparte para cuando el total cabia en la pagina ("1 de 1 se confirman
    // de un clic"). Esa frase se mudo a la cabecera de la bandeja, asi que el subtitulo tiene una
    // sola forma: el universo. Una rama menos es una contradiccion menos.
    expect(comp.subtituloJornada()).toContain('1 por confirmar');
    expect(comp.subtituloJornada()).not.toContain('de un clic');
  });

  /**
   * `[CG.32]` El cuadre ocupaba la mitad de la pantalla para publicar ceros, y la cola de trabajo
   * empezaba debajo del pliegue.
   */
  it('con el libro en CERO y cola pendiente, el cuadre se pliega', () => {
    montar({
      arqueoDia: vi.fn(() => of({ ...ARQUEO, caja_general: { ...ARQUEO.caja_general, movimientos: 0 } })),
      movimientosPendientes: vi.fn(() => of({ ...VACIA, rows: [GASTO_TRABADO], total: 1887 })),
    });
    expect(comp.verDetalleCierre()).toBe(false);
  });

  it('⛔ [negativa] con el libro en cero y SIN cola NO se pliega: ahi los ceros son la respuesta', () => {
    montar({
      arqueoDia: vi.fn(() => of({ ...ARQUEO, caja_general: { ...ARQUEO.caja_general, movimientos: 0 } })),
      movimientosPendientes: vi.fn(() => of({ ...VACIA, total: 0 })),
    });
    expect(comp.verDetalleCierre()).toBe(true);
  });

  it('⛔ [negativa] con movimientos en el libro NO se pliega, aunque haya cola', () => {
    montar({ movimientosPendientes: vi.fn(() => of({ ...VACIA, rows: [GASTO_TRABADO], total: 1887 })) });
    expect(comp.verDetalleCierre()).toBe(true);   // ARQUEO trae 3 movimientos
  });

  it('abrirlo a mano GANA sobre el plegado automatico', () => {
    // Plegarle algo que acaba de abrir seria pelearle.
    montar({
      arqueoDia: vi.fn(() => of({ ...ARQUEO, caja_general: { ...ARQUEO.caja_general, movimientos: 0 } })),
      movimientosPendientes: vi.fn(() => of({ ...VACIA, rows: [GASTO_TRABADO], total: 1887 })),
    });
    expect(comp.verDetalleCierre()).toBe(false);
    comp.cuadreAbierto.set(true);
    expect(comp.verDetalleCierre()).toBe(true);
  });

  /**
   * `[CG.30.1]` El MISMO defecto de CG.30 vivia en el renglon de al lado y se paso por alto: la
   * pantalla afirmaba dos universos distintos a cinco centimetros de distancia.
   */
  it('el renglon de la bandeja NO repite el total: declara que es sobre lo que se ve', () => {
    const fx = montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [GASTO_TRABADO], confirmables: 0, total: 1875,
      })),
    });
    // `[CG.45]` La afirmacion se mudo del string al DOM: la cifra ahora vive en la cabecera con
    // su propio peso, no dentro de una frase. Se mide lo RENDERIZADO, que es mas fuerte que
    // medir el helper -- si manana alguien deja de pintarlo, esta prueba cae.
    const head: string = fx.nativeElement.querySelector('.cg-bandeja-head').textContent;
    expect(head).toContain('de 1');
    // El total lo dice el subtitulo de la pagina; repetirlo aca seria ruido.
    expect(head).not.toContain('1,875');
    expect(comp.textoAlcance()).not.toContain('1,875');
  });

  /**
   * `[CG.33]` El motivo se pintaba ENTERO en cada fila: con 9 a la vista la tabla era un muro
   * naranja donde el aviso pesaba mas que el monto, y repetir 85 veces la misma frase tampoco
   * decia lo unico accionable: CUANTAS.
   */
  it('los motivos se agrupan y se cuentan, ordenados por cantidad', () => {
    const otro = { ...GASTO_TRABADO, folio: '0000002', motivo: 'sin_monto' as const, motivo_texto: 'x' };
    montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA,
        rows: [GASTO_TRABADO, { ...GASTO_TRABADO, folio: '0000003' }, otro],
        confirmables: 0, total: 3,
      })),
    });
    const g = comp.motivosAgrupados();
    expect(g[0].n).toBe(2);              // el mas repetido primero
    expect(g.map((x) => x.n)).toEqual([2, 1]);
  });

  it('⛔ [negativa] lo CONFIRMABLE no entra al resumen de motivos', () => {
    montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [{ ...GASTO_TRABADO, confirmable: true }], confirmables: 1, total: 1,
      })),
    });
    expect(comp.motivosAgrupados()).toEqual([]);
  });

  /**
   * `[CG.37]` El porqué de los motivos se PLIEGA. Lo que se verifica no es que exista el botón
   * sino las dos mitades del trato: que plegado NO esté el texto largo (ése era el punto — tres
   * frases de ~70 caracteres empujaban la primera fila debajo del pliegue) y que desplegado SÍ,
   * en el DOM y no en un `title`.
   */
  it('[CG.37] el porqué arranca PLEGADO y el conteo se ve igual', async () => {
    const fx = montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [GASTO_TRABADO], confirmables: 0, total: 1,
      })),
    });
    await Promise.resolve();
    fx.detectChanges();
    const html: string = fx.nativeElement.querySelector('.cg-bandeja').innerHTML;

    expect(comp.motivosAbiertos()).toBe(false);
    expect(html).toContain(comp.motivosAgrupados()[0].motivo);          // el motivo, a la vista
    expect(fx.nativeElement.querySelector('.cg-motivos-por')).toBeNull(); // la frase, no
  });

  it('[CG.37] al desplegarlo la frase entra al DOM — no vive en un title', async () => {
    const fx = montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [GASTO_TRABADO], confirmables: 0, total: 1,
      })),
    });
    await Promise.resolve();
    comp.motivosAbiertos.set(true);
    fx.detectChanges();

    const por = fx.nativeElement.querySelector('.cg-motivos-por');
    expect(por).not.toBeNull();
    expect(por.textContent).toContain(comp.motivosAgrupados()[0].texto);
  });

  /**
   * ⛔ La lección de `[CG.33]`: ahí nombré una señal nueva `cierreAbierto` sin mirar que ya
   * existía, y como en una clase gana la ÚLTIMA declaración, el botón nuevo habría abierto el
   * diálogo que SELLA el día. Ni `tsc` ni el editor lo vieron. Esta prueba es el candado: el
   * toggle del porqué mueve SU señal y no toca ninguna de las otras tres de la pantalla.
   */
  it('⛔ [negativa] desplegar el porqué no abre ningún diálogo', () => {
    montar();
    const antes = [comp.capturaAbierta(), comp.cierreAbierto(), comp.cuadreAbierto()];
    comp.motivosAbiertos.set(true);
    expect([comp.capturaAbierta(), comp.cierreAbierto(), comp.cuadreAbierto()]).toEqual(antes);
  });

  it('⛔ [negativa] sin frase que revelar, el botón del porqué NO existe', () => {
    // Un control que no revela nada es ruido, no información (DESIGN.md, salida de filtros).
    montar({
      movimientosPendientes: vi.fn(() => of({
        ...VACIA, rows: [{ ...GASTO_TRABADO, motivo_texto: '' }], confirmables: 0, total: 1,
      })),
    });
    expect(comp.motivosAgrupados().length).toBe(1);   // el motivo SÍ está
    expect(comp.hayPorque()).toBe(false);             // lo que no hay es qué desplegar
  });

  it('⛔ [negativa] una clave de motivo DESCONOCIDA se muestra tal cual, no se disfraza', () => {
    // Una clave nueva del servidor tiene que VERSE, no caer a un generico.
    montar();
    expect(comp.motivoCorto('motivo_nuevo_del_server')).toBe('motivo_nuevo_del_server');
    expect(comp.motivoCorto('sin_mapa')).toBe('ruta sin declarar');
    expect(comp.motivoCorto(null)).toBe('no confirmable');
  });

  it('los limites estructurales arrancan plegados y los accionables no', () => {
    // Antes eran tres avisos naranjas iguales y dos salian todos los dias. Un aviso inmutable que
    // grita se deja de leer, y se lleva puesto al que si importaba.
    const fx = montarJornada({
      arqueoDia: vi.fn(() => of({
        ...ARQUEO,
        no_medido: ['Todavia no rendiste cuentas de esta jornada: esto es el movimiento REGISTRADO.'],
        limites: ['Del cajero se cuadra el FLUJO del dia, no su contenido.', 'La cola de Kepler no entra.'],
      })),
    });
    const panel: string = fx.nativeElement.querySelector('.cg-conc').innerHTML;
    expect(panel).toContain('Todavia no rendiste cuentas');   // el accionable, arriba
    /**
     * `[CG.116]` **Ya no se pliegan, y el nombre de la prueba cambió con ellos.** Era el TERCER
     * desplegable de la pantalla y es el que sale en el pantallazo de Edgar. Plegar sólo protege
     * cuando lo de abajo se mueve; ahora todo esto vive dentro de una ventana, así que plegar no
     * protegía nada y sí escondía dos renglones de texto detrás de un clic.
     *
     * Lo que la prueba sigue exigiendo es el ORDEN, que era el hallazgo de `[CG.29]`: el aviso
     * accionable arriba, los límites permanentes abajo y en gris. Ordenar no es esconder.
     */
    expect(panel).toContain('Que NO cubre este cuadre (2)');
    expect(panel).toContain('La cola de Kepler no entra');
    expect(panel.indexOf('Todavia no rendiste cuentas')).toBeLessThan(panel.indexOf('Que NO cubre este cuadre'));
  });
  // ── [CG.43] La marca pertenece a la lista que se ve ────────────────────────────────────────
  //
  // Medido en prod el 2026-10-06: 1,925 movimientos en la ventana, de los que 1,212 son
  // confirmables de un clic. La bandeja viene TOPADA en 100 y el propio aviso de la pantalla
  // dice "acotá por signo o por caja para verlas todas" — o sea que cambiar de filtro es la
  // navegación PREVISTA, y es justo lo que dejaba la selección colgada.
  //
  // `seleccion` sólo se podaba dentro de `restaurarBorrador()`, que corre UNA vez por visita.
  // Después de eso, cada recarga reemplaza las filas y deja las marcas viejas adentro: el botón
  // "Confirmar N" cuenta filas invisibles, y al tocarlo las ESCRIBE en el libro.
  describe('[CG.43] la seleccion no sobrevive a un cambio de filtro', () => {
    /** Una pagina que NO comparte ninguna referencia con CON_DOS. */
    const OTRA_PAGINA: PendientesResponse = {
      rows: [{ ...FILA_A, origen_ref: '00|U-A-5|0009001|0011', folio: '0009001', tipo: 'ingreso' }],
      limit: 100, has_more: false, confirmables: 1, desde: '2026-09-21', ventana_dias: 1,
    };

    it('⛔ cambiar de filtro NO puede dejar marcadas filas que ya no estan en pantalla', () => {
      const pend = vi.fn(() => of(CON_DOS));
      montar({ movimientosPendientes: pend });

      comp.marcarTodas(true);
      expect(comp.marcadas().length).toBe(2);

      // La persona acota por signo: la bandeja trae OTRA pagina, sin ninguna de las dos filas.
      pend.mockReturnValue(of(OTRA_PAGINA) as never);
      comp.setSigno('ingreso');

      // El boton dice "Confirmar N". Ese N no puede contar filas invisibles.
      const vivas = new Set(comp.pendientes().map((p) => p.origen_ref));
      for (const ref of comp.marcadas()) {
        expect(vivas.has(ref), 'quedo marcada una fila que no esta en la lista: ' + ref).toBe(true);
      }
      expect(comp.marcadas().length).toBe(0);
    });

    it('⛔ confirmar el lote NO puede escribir asientos de filas invisibles', () => {
      const pend = vi.fn(() => of(CON_DOS));
      montar({ movimientosPendientes: pend });

      comp.marcarTodas(true);
      pend.mockReturnValue(of(OTRA_PAGINA) as never);
      comp.setSigno('ingreso');
      comp.confirmarLote();

      // Lo que NO puede pasar es que se vayan al servidor las referencias de la pagina vieja.
      const enviados = (svc['confirmarLote'].mock.calls as unknown[][])
        .flatMap((c) => (c[0] as Array<{ origen_ref: string }>).map((x) => x.origen_ref));
      expect(enviados).not.toContain(FILA_A.origen_ref);
      expect(enviados).not.toContain(FILA_B.origen_ref);
    });

    it('✔ [negativa] lo que SIGUE en la lista conserva su marca', () => {
      // El arreglo PODA, no vacia. Sin esta prueba, un `seleccion.set(new Set())` en cada carga
      // pasaria las dos de arriba y rompería el repaso de fondo de 60 s, que recarga la bandeja
      // sin que la persona toque nada: se le borrarian las marcas cada minuto.
      const pend = vi.fn(() => of(CON_DOS));
      montar({ movimientosPendientes: pend });
      comp.marcarTodas(true);
      expect(comp.marcadas().length).toBe(2);

      comp.cargarPendientes(true);   // refresco de fondo: la misma pagina, otra vez
      expect([...comp.marcadas()].sort()).toEqual([FILA_A.origen_ref, FILA_B.origen_ref].sort());
    });
  });
  // ── [CG.45] El repertorio compartido, no un vocabulario propio ──────────────────────────────
  //
  // De 13 componentes compartidos esta pantalla usaba 2, mientras el resto de /finanzas ya usaba
  // los otros. No es cosmetico: la frescura como PROSA gris no se pone ambar cuando el dato
  // envejece, y un desplegable de tres valores esconde las dos alternativas.
  describe('[CG.45] usa el repertorio compartido, no piezas propias', () => {
    it('la frescura es la pildora canonica, y declara cuando no se pudo medir', () => {
      const fx = montar({
        movimientosPendientes: vi.fn(() => of({ ...VACIA, datos_al: '2026-10-06T18:00:00Z' })),
      });
      expect(fx.nativeElement.querySelector('app-freshness-pill')).toBeTruthy();

      // Tercer estado: sin `datos_al` no se esconde -- se DECLARA (ADR-056).
      TestBed.resetTestingModule();
      const fx2 = montar({ movimientosPendientes: vi.fn(() => of({ ...VACIA, datos_al: null })) });
      const head: string = fx2.nativeElement.querySelector('.cg-bandeja-head').textContent;
      expect(fx2.nativeElement.querySelector('app-freshness-pill')).toBeFalsy();
      expect(head).toContain('frescura sin medir');
    });

    it('el signo es un control segmentado, no un desplegable', () => {
      const fx = montar();
      expect(fx.nativeElement.querySelector('app-segmented')).toBeTruthy();
      // Las tres opciones siguen siendo las mismas y en el mismo orden.
      expect(comp.opcionesSigno.map((o) => o.value)).toEqual(['', 'ingreso', 'gasto']);
    });

    it('la ayuda de contexto existe y sale del DICCIONARIO, no del template', () => {
      const fx = montar();
      expect(fx.nativeElement.querySelector('app-context-help')).toBeTruthy();
      // Regla P: la entrada tiene que existir, o el boton no se pinta y queda un hueco mudo.
      expect(CONTEXT_HELP['caja-general']).toBeTruthy();
      expect(CONTEXT_HELP['caja-general'].groups?.length).toBeGreaterThan(0);
    });

    it('⛔ [negativa] el espaciado sale de la escala, no de valores a mano', () => {
      // La causa mecanica de que la pantalla "no se sintiera bien": 20 valores distintos, 14 de
      // ellos fuera de la rejilla de 4px, mientras sus hermanas de /finanzas usaban 0 o 1.
      const fuente = FinanzasCajaGeneralComponent as unknown as { ɵcmp?: { styles?: string[] } };
      const css = (fuente.ɵcmp?.styles ?? []).join('\n');
      const crudos = (css.match(/(padding|margin|gap)[a-z-]*: *[^;}]*[0-9]*\.?[0-9]+rem/g) ?? [])
        // El micro-nudge del chip (<4px) es excepcion declarada en DESIGN.md §Spacing.
        .filter((d) => !/\.1rem \.45rem/.test(d));
      expect(crudos, 'espaciado fuera de la escala --sp-*: ' + crudos.join(' | ')).toEqual([]);
    });
  });
  // ── [CG.46] O.1: master-detail permanente, la captura fuera del modal ───────────────────────
  //
  // DESIGN.md O.1 es BINDING para /finanzas/*: split permanente, y el modal queda para
  // "confirmar/crear CORTO". La captura de caja tiene documento, contraparte, cuenta, concepto,
  // glosa, monto, la reja de 16 denominaciones y el panel del cajero: 397 lineas de formulario
  // dentro de un dialogo de 62rem que tapaba la bandeja entera mientras se capturaba.
  describe('[CG.46] la captura vive en el detalle, no en un modal', () => {
    /**
     * ⚠️ 2026-10-16 — SE DA VUELTA. `[CG.46]` exigía un detalle PERMANENTE con su vacío
     * operacional («Nada elegido todavía» + una acción), y era correcto cuando el detalle
     * compartía la pantalla con la cola a mitades.
     *
     * Edgar, sobre la pantalla ya armada: *"usemos toda la pantalla para presentar los
     * movimientos"*. Ese vacío ocupaba ~200px ARRIBA de la cola — le explicaba a la persona
     * lo que estaba mirando quitándole el espacio para mirarlo. Con la lista a pantalla
     * completa es justo lo que no se puede gastar.
     *
     * ⭐ Lo que `[CG.46]` protegía NO se pierde y por eso esta prueba no se borra, se invierte:
     * la guía sigue en pantalla (en el rótulo del apartado, que cambia con el estado) y la
     * acción de registrar sigue existiendo (el CTA de la cabecera, que siempre estuvo ahí y
     * era *la misma acción* — eso lo había medido `[CG.47]`).
     */
    it('⭐ sin nada elegido NO hay panel de detalle: la lista ocupa la pantalla', () => {
      const fx = montar();
      expect(comp.capturaAbierta()).toBe(false);
      expect(fx.nativeElement.querySelector('.cg-detail'),
        'el detalle vacío volvió a ocupar ~200px arriba de la cola').toBeNull();
      expect(fx.nativeElement.querySelector('.cg-detail-nada')).toBeNull();

      // Y la guía no se perdió: la dice el rótulo, que es donde la persona está mirando.
      const hint: HTMLElement = fx.nativeElement.querySelector('.cg-ap-que .cg-ap-hint');
      expect(hint.textContent, 'sin el vacío, nada dice que la cola se toca').toContain('cola');

      // La acción tampoco: el CTA de la cabecera es la MISMA que ofrecía el vacío ([CG.47]).
      const cta: HTMLElement | null = fx.nativeElement.querySelector('.cg-jornada-barra p-button, .surf-page-head p-button');
      expect(cta ?? fx.nativeElement.textContent, 'no quedó forma de registrar desde cero').toBeTruthy();
    });

    it('⭐ al elegir, el detalle aparece en el MISMO lugar (no en un modal)', () => {
      // Lo que `[CG.46]` vino a arreglar sigue vigente: la captura NO es un diálogo encima.
      const fx = montar();
      comp.abrirCaptura();
      fx.detectChanges();
      const panel = fx.nativeElement.querySelector('.cg-detail');
      expect(panel, 'el detalle tiene que aparecer en el flujo de la página').toBeTruthy();
      expect(panel.closest('p-dialog'), 'la captura volvió a ser un modal').toBeNull();
      expect(panel.closest('.cg-ap-que'), 'el detalle salió del apartado 1').toBeTruthy();
    });

    it('⛔ la captura NO se pinta dentro de un p-dialog', () => {
      const fx = montar();
      comp.capturarDesde(FILA_A);
      fx.detectChanges();

      const panel = fx.nativeElement.querySelector('.cg-detail');
      // El formulario esta DENTRO del detalle...
      expect(panel.querySelector('.fin-form'), 'el formulario va en el panel').toBeTruthy();
      // ...y su salida tambien. ⭐ [CG.62] Guardar YA NO esta aca: bajo al pie del arqueo, que es
      // donde termina el trabajo. Lo que queda en la ficha es Cancelar, que es la salida.
      expect(panel.querySelector('.cg-detail-pie'), 'el pie va en el panel').toBeTruthy();
      expect(panel.querySelector('.cg-detail-pie').textContent).toContain('Cancelar');

      // ⛔ Y NINGUN dialogo abierto lo contiene. Es la asercion que define O.1: si manana alguien
      // lo devuelve a un p-dialog, esto cae.
      for (const d of Array.from(fx.nativeElement.querySelectorAll('p-dialog'))) {
        expect((d as HTMLElement).querySelector('.fin-form'),
          'el formulario de captura volvio a un modal').toBeFalsy();
      }
    });

    it('✔ [negativa] la apertura de caja SI se queda como modal: es confirmar corto', () => {
      // O.1 no prohibe el modal: lo reserva. Sin esta prueba, "sacar los dialogos" se leeria
      // como que hay que sacarlos todos, y el de apertura son tres campos.
      const fx = montar();
      comp.abrirApertura();
      fx.detectChanges();
      expect(comp.aperturaAbierta()).toBe(true);
      expect(fx.nativeElement.querySelector('p-dialog'),
        'la apertura sigue siendo un dialogo').toBeTruthy();
    });

    it('la reja se arma por el ancho de SU APARTADO, no por el de la ventana', () => {
      // §R: un bloque que se embebe decide su layout con @container. Con @media, en un monitor
      // ancho la consulta no dispara nunca y las dos columnas de la reja se desbordan.
      // ⭐ [CG.60] Esto vigilaba `.cg-grid`, que se retiró con los dos apartados. El bloque que
      // queda embebido —y que de verdad se rompió en vivo— es la REJA: su `@container` es el que
      // [CG.57] tuvo que reapuntar. Es él quien hereda la guardia.
      const fuente = FinanzasCajaGeneralComponent as unknown as { ɵcmp?: { styles?: string[] } };
      const css = (fuente.ɵcmp?.styles ?? []).join('\n');

      // La reja se arma por CONTENEDOR...
      expect(css).toMatch(/@container[^{]*\{[^}]*\.cg-reja2/);

      // ...y NINGUN @media decide sobre ella. ⚠️ La version anterior de esta prueba buscaba el
      // string "47.5rem" a secas y daba DOS falsos positivos: ese ancho sigue siendo legitimo
      // para .cg-conc-cols (chrome de pagina, le toca @media por §R), y ademas el comentario que
      // explica el cambio CITA la regla vieja. Se mide lo que importa: quien gobierna la reja.
      const medias = css.match(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
      const culpables = medias.filter((m) => m.includes('.cg-reja2'));
      expect(culpables, 'un @media decide el layout de la reja: ' + culpables.join(' | '))
        .toEqual([]);
    });
  });
  // ── [CG.47] Colorimetria: el naranja vuelve a significar "apreta aca" ───────────────────────
  //
  // Medido sobre una captura real de la pantalla: CUATRO botones en --action al mismo tiempo
  // (Registrar movimiento · Cerrar jornada · Confirmar 0 · Registrar uno nuevo), y DOS de ellos
  // llaman al MISMO metodo con rotulos distintos. DESIGN.md lo lista como antipatron: "dos
  // acciones en --action en la misma fila: la que escribe en la DB deja de ser la obvia".
  describe('[CG.47] una sola accion de marca por region', () => {
    it('⛔ el boton de Confirmar NO se pinta de marca cuando no hay nada que confirmar', () => {
      const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
      expect(comp.marcadas().length).toBe(0);

      const confirmar = Array.from(fx.nativeElement.querySelectorAll('button'))
        .find((b) => (b as HTMLElement).textContent?.includes('Confirmar')) as HTMLElement;
      expect(confirmar, 'no se encontro el boton Confirmar').toBeTruthy();
      // Apagado Y neutro: un boton de marca que no hace nada es ruido de color.
      expect(confirmar.className).toContain('p-button-secondary');
      // Y no publica un cero: "Confirmar 0" es una cifra que no le sirve a nadie.
      expect(confirmar.textContent).not.toContain('0');

      // Con algo marcado SI es la accion obvia: recupera el naranja y su cuenta.
      comp.marcarTodas(true);
      fx.detectChanges();
      const conMarcas = Array.from(fx.nativeElement.querySelectorAll('button'))
        .find((b) => (b as HTMLElement).textContent?.includes('Confirmar')) as HTMLElement;
      expect(conMarcas.className).not.toContain('p-button-secondary');
      expect(conMarcas.textContent).toContain('2');
    });

    /**
     * ⭐ 2026-10-16 — `[CG.47]` midió que el vacío del detalle y el CTA de la cabecera eran la
     * MISMA acción llamando al mismo método, y bajó uno a secundario para que no hubiera dos
     * naranjas compitiendo. Al retirarse el vacío (la lista ocupa la pantalla), **el problema
     * desaparece en vez de resolverse**: queda un solo botón.
     *
     * La prueba no se borra, se convierte en lo que de verdad importaba: que haya **UNA sola
     * acción de marca** en la pantalla en reposo. Borrarla dejaría libre el camino para que
     * mañana entren tres naranjas otra vez.
     */
    it('⛔ en reposo hay UNA sola acción de marca en pantalla', () => {
      const fx = montar();
      const marcados = Array.from(
        fx.nativeElement.querySelectorAll('button'),
      ).filter((b) => {
        const c = (b as HTMLElement).className || '';
        // El naranja de marca es el botón primario de PrimeNG: ni secondary, ni text, ni outlined.
        return c.includes('p-button') && !/secondary|text|outlined|p-button-icon-only/.test(c);
      });
      expect(marcados.length,
        'más de una acción de marca: cuando hay cuatro naranjas ninguna lo es — ' +
        marcados.map((b) => (b as HTMLElement).textContent?.trim()).join(' | '))
        .toBeLessThanOrEqual(1);
    });

    it('⛔ la marca de fila no levanta un muro ambar: el ambar es del contador agrupado', () => {
      // Todas las filas trabadas llevan la MISMA marca. Una senal que aparece en el 100% de las
      // filas no distingue nada; el ambar queda para el contador, que es lo accionable.
      const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
      const tag = fx.nativeElement.querySelector('.cg-motivo-tag') as HTMLElement;
      expect(tag, 'la fila trabada sigue llevando su marca').toBeTruthy();
      expect(tag.className).not.toContain('p-tag-warn');
    });

    it('⛔ [negativa] la marca de fila NO hereda el atenuado de la fila trabada', () => {
      // [CG.33] escribio esta exclusion despues de MEDIR el contraste, y apuntaba a ".cg-motivo"
      // cuando la clase real es ".cg-motivo-tag": el selector no casaba con nada y la regla nunca
      // se aplico. Un caracter.
      const fuente = FinanzasCajaGeneralComponent as unknown as { ɵcmp?: { styles?: string[] } };
      const css = (fuente.ɵcmp?.styles ?? []).join('\n');
      expect(css).toMatch(/\.cg-trabada[^{]*\.cg-motivo-tag[^{]*\{[^}]*opacity\s*:\s*1/);
    });
  });

  // ⭐⭐ `[CG.180]` LA FUENTE DEL AUTOLLENADO: tres estados, y sólo uno es un problema del dato.
  //
  // La sesión de backend midió que `analytics.mv_caja_autofill_entidad` llegó a producción
  // poblada y con CERO filas. Con la copia vacía el motor contesta `sin_historia` para toda
  // entidad, así que esta pantalla le afirmaba al capturista «Kepler no tiene historia de este
  // beneficiario» — una afirmación sobre el proveedor cuando el hecho era sobre nosotros.
  describe('[CG.180] la fuente del autollenado se DECLARA', () => {
    const LATIDO = {
      data_as_of: '2026-10-13T12:00:00-06:00', status: 'fresh' as const, stale: false,
      age_human: 'hace 20 min', inputs: [],
    };
    const conAutofill = (declarada: number, derivada: number, latido: typeof LATIDO | null = LATIDO) =>
      vi.fn(() => of({ ...COBERTURA, autofill: { declarada, derivada, latido } }));

    it('con la copia VACÍA lo dice, y lo dice como aviso', () => {
      const fx = montarJornada({ cobertura: conAutofill(0, 0) });
      expect(comp.autofillFuenteVacia()).toBe(true);
      expect(fx.nativeElement.textContent).toContain('copia del historial está vacía');
    });

    it('[control] con la copia POBLADA no hay aviso: el mismo campo, otro valor', () => {
      const fx = montarJornada({ cobertura: conAutofill(12, 285) });
      expect(comp.autofillFuenteVacia()).toBe(false);
      expect(fx.nativeElement.textContent).not.toContain('copia del historial está vacía');
      expect(fx.nativeElement.textContent).toContain('285');
    });

    it('⛔ el campo AUSENTE no se lee como copia vacía: son dos ausencias distintas', () => {
      // La API desplegada todavía no manda `autofill`. «No sé» no puede pintarse igual que
      // «la copia está vacía», que es la falla que esta tanda vino a arreglar.
      const fx = montarJornada();                // COBERTURA pelada, sin el campo
      expect(comp.autofill()).toBeUndefined();
      expect(comp.autofillFuenteVacia(), 'undefined NO es vacía').toBe(false);
      expect(fx.nativeElement.textContent).toContain('Autollenado: sin medir');
      expect(fx.nativeElement.textContent).not.toContain('copia del historial está vacía');
    });

    it('«el carril nunca corrió» es su propio estado, no un refresco viejo', () => {
      const fx = montarJornada({ cobertura: conAutofill(0, 285, null) });
      expect(fx.nativeElement.textContent).toContain('nunca corrió');
    });

    it('la frase de la captura deja de culpar al beneficiario cuando la copia está vacía', () => {
      montar({
        cobertura: conAutofill(0, 0),
        autofill: vi.fn(() => of({
          concepto: { value: null, source: null, confidence: null, reason: 'sin_historia' },
          provenance: null,
        })),
      });
      comp.abrirCaptura();
      comp.pedirPropuesta();
      expect(comp.etiquetaConcepto().texto).toContain('copia del historial');
      expect(comp.etiquetaConcepto().texto).not.toContain('no hay historia de este proveedor');
    });

    it('[control] con la copia poblada, esa misma frase sigue siendo la de siempre', () => {
      montar({
        cobertura: conAutofill(12, 285),
        autofill: vi.fn(() => of({
          concepto: { value: null, source: null, confidence: null, reason: 'sin_historia' },
          provenance: null,
        })),
      });
      comp.abrirCaptura();
      comp.pedirPropuesta();
      expect(comp.etiquetaConcepto().texto).toContain('no hay historia de este proveedor');
    });
  });

  // ⛔⛔ `[CG.181]` EL 429 DE PRODUCCIÓN: una petición repetida que volvía CERO y se publicaba
  // como un hecho. Medido en prod el 2026-10-14 con la pantalla abierta: la lista de cortes salía
  // dos veces con los mismos parámetros, la segunda daba 429, el manejador de error vaciaba la
  // lista, y el resumen imprimía «0 corte(s)» mientras el endpoint devolvía 1 (CC-2026-00001).
  describe('[CG.181] una lista que falló no se publica como cero', () => {
    it('⛔ los cortes se piden UNA vez al entrar, no dos', () => {
      const cortes = vi.fn(() => of({ rows: [], limit: 50 }));
      montar({ cortes });
      expect(cortes, 'ngOnInit + el next de cargar() = 429 en la segunda').toHaveBeenCalledTimes(1);
    });

    it('[control] mover una fecha SÍ los vuelve a pedir: el rango es su insumo', () => {
      const cortes = vi.fn(() => of({ rows: [], limit: 50 }));
      montar({ cortes });
      comp.setDesde(new Date(2026, 8, 1));
      expect(cortes).toHaveBeenCalledTimes(2);
    });

    it('[control] cambiar el TIPO ya no los arrastra: no los toca', () => {
      const cortes = vi.fn(() => of({ rows: [], limit: 50 }));
      montar({ cortes });
      comp.cargar();                       // lo que hace el selector de tipo / la búsqueda
      expect(cortes, 'cargar() dejó de disparar cortes').toHaveBeenCalledTimes(1);
    });

    it('⛔ con los cortes caídos el resumen lo DICE, y no imprime «0 corte(s)»', () => {
      const fx = montarJornada({ cortes: vi.fn(() => throwError(() => ({ status: 429 }))) });
      const txt = fx.nativeElement.textContent as string;
      expect(txt).toContain('los cortes no se pudieron leer');
      expect(txt, 'un cero afirma lo que nadie midió').not.toContain('0 corte(s)');
    });

    // `[CG.123]` El CONTEO vive en la cabecera del Historial, que es su sección. Lo que no
    // depende de la sección es la DECLARACIÓN de un hueco: eso se comprueba parado en «Hoy»,
    // en la prueba negativa del selector.
    it('[control] con los cortes sanos el conteo se publica igual que siempre', () => {
      const fx = montarJornadaEn('historial', {
        cortes: vi.fn(() => of({ rows: [{ id: 'c1', folio: 'CC-2026-00001' }], limit: 50 })),
      });
      expect(fx.nativeElement.textContent).toContain('1 corte(s)');
    });

    it('⛔ y las dos mitades son independientes: el libro caído no tapa los cortes medidos', () => {
      const fx = montarJornadaEn('historial', {
        libro: vi.fn(() => throwError(() => ({ status: 500 }))),
        cortes: vi.fn(() => of({ rows: [{ id: 'c1', folio: 'CC-2026-00001' }], limit: 50 })),
      });
      const txt = fx.nativeElement.textContent as string;
      expect(txt).toContain('el libro no se pudo leer');
      expect(txt, 'los cortes SÍ se midieron').toContain('1 corte(s)');
    });

    it('⛔ una recarga fallida de frecuentes NO borra los chips que ya se midieron', () => {
      let falla = false;
      const frecuentes = vi.fn(() => (falla
        ? throwError(() => ({ status: 429 }))
        : of({ rows: [FRECUENTE], medido: { pares_con_soporte: 1, minimo_usos: 3 } })));
      montar({ frecuentes });
      expect(comp.frecuentes().length).toBe(1);
      falla = true;
      comp.cargarFrecuentes();
      expect(comp.frecuentes().length, 'vaciar es publicar «no repite nada»').toBe(1);
    });
  });

  // ⭐⭐ `[CG.182]` EL CORTE DE CAJA EN LA LISTA — la declaración deja de teclearse.
  //
  // Medido en prod: 708 referencias distintas en 749 depósitos, cero parseables; y por plaza,
  // 31 de 34 declaran ruta+fecha en la 00 contra **0 de 16** en Morelia.
  describe('[CG.182] el corte de caja se elige, no se teclea', () => {
    const CORTE = (over: Partial<CorteRow> = {}): CorteRow => ({
      clave: '07-UD2301-0000029', sucursal: '07', sucursal_nombre: 'Morelia Madero',
      documento: 'UD2301-0000029', folio: '0000029', fecha: '2026-10-08',
      referencia: 'Caja 4-199', caja: '4', turno: '199', monto: 41333.04,
      cobrado: 0, saldo: 41333.04, estado_cobro: 'sin_cobro', cobros: [],
      devoluciones: [], devoluciones_total: 0, arqueo: null,
      cuadre: 'sin_arqueo', diferencia: null, ...over,
    } as CorteRow);

    const conCortes = (cortes: CorteRow[], ultimo: string | null = '2026-10-13') =>
      vi.fn(() => of({
        periodo: { from: '2026-10-08', to: '2026-10-14' },
        alcance: { todas: true, sucursales: [] },
        totales: { cortes: cortes.length, vendido: 0, cobrado: 0, pendiente: 0, sin_cobro: 0, con_diferencia: 0, sin_arqueo: 0 },
        sucursales: [], cortes, cortes_en_blanco: 0, ultimo_corte: ultimo,
      }));

    it('elegirlo ESCRIBE el «Qué pasó» con caja, plaza y fecha', () => {
      montar();
      comp.abrirCaptura();
      comp.usarCorte({ value: CORTE() } as never);
      const g = comp.f().glosa;
      expect(g).toContain('Caja 4-199');
      expect(g).toContain('Morelia Madero');
      expect(g).toContain('08/10/26');
    });

    it('⛔ [negativa] NO copia el monto del corte: se guarda lo CONTADO', () => {
      // En el caso real faltan $4,508.99 entre lo vendido y lo depositado (monedas que CAOS no
      // toma + lo no depositado). Copiar el monto inventaría un depósito que no ocurrió.
      montar();
      comp.abrirCaptura();
      const antes = comp.f().monto;
      comp.usarCorte({ value: CORTE({ monto: 41333.04 }) } as never);
      expect(comp.f().monto).toBe(antes);
    });

    it('el importe ORDENA: el más cercano a lo contado va primero', () => {
      montar({ cortesDeCaja: conCortes([
        CORTE({ clave: 'a', monto: 3120, fecha: '2026-10-12' }),
        CORTE({ clave: 'b', monto: 41333.04, fecha: '2026-10-08' }),
      ]) });
      comp.f.update((v) => ({ ...v, monto: 36440 }));
      comp.cargarCortesPos();
      comp.buscarCortes({ query: '' } as never);
      expect(comp.cortesOpciones()[0].clave, 'el de $41,333 está más cerca de $36,440').toBe('b');
    });

    it('[control] sin monto contado manda la FECHA, no un orden inventado', () => {
      montar({ cortesDeCaja: conCortes([
        CORTE({ clave: 'viejo', monto: 99999, fecha: '2026-10-08' }),
        CORTE({ clave: 'nuevo', monto: 10, fecha: '2026-10-13' }),
      ]) });
      comp.cargarCortesPos();
      comp.buscarCortes({ query: '' } as never);
      expect(comp.cortesOpciones()[0].clave).toBe('nuevo');
    });

    it('⛔ «hoy vacío» se DECLARA: el rezago de carga no es «no hubo cortes»', () => {
      montar({ cortesDeCaja: conCortes([CORTE()], '2026-10-13') });
      comp.cargarCortesPos();
      expect(comp.cortesAviso()).toContain('rezago');
    });

    it('⛔ y un FALLO no se pinta como lista vacía', () => {
      montar({ cortesDeCaja: vi.fn(() => throwError(() => ({ status: 500 }))) });
      comp.cargarCortesPos();
      expect(comp.cortesAviso()).toContain('no se pudo preguntar');
      expect(comp.cortesAviso(), 'un fallo no afirma que no haya cortes').not.toContain('Sin cortes');
    });

    it('[control] lista vacía de verdad dice que está vacía, no que falló', () => {
      montar({ cortesDeCaja: conCortes([], null) });
      comp.cargarCortesPos();
      expect(comp.cortesAviso()).toContain('Sin cortes');
    });

    it('se busca por CÓDIGO de sucursal: el papel puede decir «03», no «8 Esquinas»', () => {
      montar({ cortesDeCaja: conCortes([
        CORTE({ clave: 'ph', sucursal: '01', sucursal_nombre: 'Padre Hidalgo' }),
        CORTE({ clave: 'ocho', sucursal: '03', sucursal_nombre: '8ESQ' }),
      ]) });
      comp.f.update((v) => ({ ...v, sucursal: '' }));   // sin acotar, para ver las dos
      comp.cargarCortesPos();
      comp.buscarCortes({ query: '03' } as never);
      expect(comp.cortesOpciones().map((c) => c.clave)).toEqual(['ocho']);
    });

    it('la lista se acota a la sucursal que se captura: 20 candidatos, no los 195 de la red', () => {
      montar({ cortesDeCaja: conCortes([
        CORTE({ clave: 'mia', sucursal: '00' }),
        CORTE({ clave: 'ajena', sucursal: '04' }),
      ]) });
      comp.f.update((v) => ({ ...v, sucursal: '00' }));
      comp.cargarCortesPos();
      expect(comp.cortesPos().map((c) => c.clave)).toEqual(['mia']);
    });
  });

  // `[CG.180]` Las dos mitades del cajón: una guarda, o ninguna.
  describe('[CG.180] el cajón viaja acoplado', () => {
    const conCajon = (cg: Record<string, unknown>) =>
      vi.fn(() => of({ ...ARQUEO, caja_general: { ...ARQUEO.caja_general, ...cg } }));

    it('toma el objeto acoplado cuando el servidor lo manda', () => {
      montar({ arqueoDia: conCajon({ cajon: { en_el_cajon: 120.5, a_la_boveda: 900 } }) });
      expect(comp.cajon()).toEqual({ en_el_cajon: 120.5, a_la_boveda: 900 });
    });

    it('con la API vieja lo arma de los dos planos', () => {
      montar({ arqueoDia: conCajon({ en_el_cajon: 120.5, a_la_boveda: 900 }) });
      expect(comp.cajon()).toEqual({ en_el_cajon: 120.5, a_la_boveda: 900 });
    });

    it('⛔ [negativa] con UNA sola mitad devuelve null — medio cajón no se publica', () => {
      // Es el caso que dibujaba $0.00: `money(null)` da «$0.00» y un cero afirma que no quedó
      // nada en el cajón, que es otra cosa que no poder saberlo.
      montar({ arqueoDia: conCajon({ en_el_cajon: 120.5, a_la_boveda: null }) });
      expect(comp.cajon()).toBeNull();
    });

    it('el servidor diciendo `cajon: null` (sin cajero) manda sobre los planos', () => {
      montar({ arqueoDia: conCajon({ cajon: null, en_el_cajon: 120.5, a_la_boveda: 900 }) });
      expect(comp.cajon()).toBeNull();
    });
  });

  /**
   * ⭐⭐ `[CG.194]` — **LO QUE LA TABLA YA DESCONTÓ TIENE QUE TENER NOMBRE Y CIFRA.**
   *
   * Medido en producción el 2026-10-19: el libro tenía **$8,179.00** de gastos y la pantalla
   * publicaba **$3,109.00** bajo un renglón rotulado «Gastos», dentro de una tabla titulada
   * «Caja general (nuestro libro)». Los **$5,070.00** de diferencia son un gasto pagado con
   * efectivo que dispensó la máquina: el servidor los resta bien —ese dinero nunca pasó por el
   * cajón— pero no lo decía, y el MISMO importe reaparecía sumado del otro lado («de eso, a la
   * bóveda $270,200.00» contra «Movimiento de la bóveda $265,130.00»). Tres cifras correctas y
   * ninguna explicando a las otras.
   *
   * ⚠️ Las pruebas afirman los TRES casos, no la cifra. El que importa es el primero: `undefined`
   * tiene que dar «sin medir» y no `null`, porque `null` apaga el renglón igual que un cero y
   * volvería a esconder el recorte sin decirlo — el defecto que esto vino a cerrar.
   */
  describe('[CG.194] el recorte de la bóveda se declara, no se omite', () => {
    const conBoveda = (cg: Record<string, unknown>) =>
      vi.fn(() => of({ ...ARQUEO, caja_general: { ...ARQUEO.caja_general, ...cg } }));

    it('con las dos piernas en cero no pinta nada: es un cero de verdad', () => {
      montar({ arqueoDia: conBoveda({ se_fue_a_boveda: { ingresos: 0, gastos: 0, movimientos: 0 } }) });
      expect(comp.boveda()).toBeNull();
      expect(comp.bovedaCifras()).toBeNull();
    });

    it('con una pierna > 0 publica el objeto entero, con su conteo', () => {
      montar({ arqueoDia: conBoveda({ se_fue_a_boveda: { ingresos: 0, gastos: 5070, movimientos: 1 } }) });
      expect(comp.bovedaCifras()).toEqual({ ingresos: 0, gastos: 5070, movimientos: 1 });
    });

    it('⛔ [negativa] el campo AUSENTE da «sin_medir», nunca null', () => {
      // Una API vieja no manda `se_fue_a_boveda`. Devolver `null` acá apagaría el renglón igual
      // que un cero, y los de arriba seguirían viniendo recortados SIN avisar: exactamente el
      // defecto original, reintroducido por la vía del deploy parcial.
      // ⚠️ Se parte de un arqueo que SÍ trae el campo y se le quita. Hacerlo desde el fixture
      // base —que nunca lo tuvo— daría verde sin probar nada: la prueba tiene que ejercer la
      // AUSENCIA, no coincidir con ella.
      const conCampo = { ...ARQUEO.caja_general, se_fue_a_boveda: { ingresos: 0, gastos: 5070, movimientos: 1 } };
      expect(conCampo.se_fue_a_boveda).toBeDefined();
      const { se_fue_a_boveda: _omitido, ...sinCampo } = conCampo;
      expect('se_fue_a_boveda' in sinCampo).toBe(false);
      montar({ arqueoDia: vi.fn(() => of({ ...ARQUEO, caja_general: sinCampo })) });
      expect(comp.boveda()).toBe('sin_medir');
      expect(comp.bovedaCifras()).toBeNull();
    });

    it('⛔ [negativa] las dos piernas NO se suman en un total', () => {
      // Un ingreso que se tragó la máquina y un gasto que salió de ella van en sentidos
      // contrarios: un total único los compensaría y volvería a esconder el recorte. Cada
      // pierna viaja por su lado y corrige SU renglón.
      montar({ arqueoDia: conBoveda({ se_fue_a_boveda: { ingresos: 5070, gastos: 5070, movimientos: 2 } }) });
      const b = comp.bovedaCifras()!;
      expect(b.ingresos).toBe(5070);
      expect(b.gastos).toBe(5070);
    });
  });

/**
 * ⭐⭐ `[CG.160]` — EL CORTE QUE NO SE PODÍA CERRAR, TRES JORNADAS SEGUIDAS.
 *
 * Medido en producción el 2026-10-14: `CC-2026-00001` (12-oct, sucursal 00) tenía su conteo
 * SELLADO —`contado = 3,653.50`, seis renglones de denominación en la base— y seguía en
 * `borrador`. `abrirCierre()` ponía `revelado()` en `null` incondicionalmente, así que después
 * de recargar la pestaña el diálogo sólo ofrecía «Guardar conteo», el servidor contestaba
 * *«este corte ya tiene un conteo sellado»*, y «Cerrar corte» no se pintaba NUNCA.
 *
 * Y no afectaba a un día: `ux_cash_cut_abierto` admite un solo borrador por sucursal, así que
 * el corte trabado trancó también el del 13 y el del 14. **Un corte que no cierra tranca todos
 * los que vienen detrás.**
 *
 * ⚠️ Estas pruebas afirman la PROPIEDAD («con conteo sellado se puede cerrar»), no la cifra:
 * un literal `3653.50` envejece con los datos y además pasaría igual si alguien reintrodujera
 * el defecto de un modo que hoy dé casualmente lo mismo.
 */
describe('[CG.160] cierre de un corte con conteo ya sellado', () => {
  /** El saldo tal como lo manda `saldo()` para un corte abierto con conteo sellado. */
  function conSellado(sellado: unknown) {
    return vi.fn(() => of({
      ...SALDO,
      sin_corte_abierto: false,
      corte_abierto: {
        id: 'c1', folio: 'CC-2026-00001', fondo_inicial: 3327.5, ya_reconto: false,
        conteo_sellado: sellado,
      },
    } as unknown as SaldoResponse));
  }

  it('⛔ el conteo sellado del servidor HABILITA cerrar tras recargar', () => {
    montar({
      saldo: conSellado({
        contado: 3653.5, esperado: null, diferencia: null,
        veredicto: 'sin_medir', ya_reconto: false,
      }),
    });
    comp.abrirCierre();
    // La revelación existe aunque nadie selló NADA en esta sesión: `revelado()` sigue en null.
    expect(comp.revelado()).toBeNull();
    expect(comp.revelacion()).not.toBeNull();
    expect(comp.revelacion()!.contado).toBe(3653.5);
    // Y es lo único que importa: el botón «Cerrar corte» cuelga de este gate.
    expect(comp.gateCierre().ok).toBe(true);
  });

  it('⛔ [negativa] sin conteo sellado NO se puede cerrar — el arqueo ciego sigue entero', () => {
    // El caso normal, que es el que más vale proteger: si esto se pusiera verde, el arreglo
    // habría abierto «Cerrar corte» sobre un corte que nadie contó.
    montar({ saldo: conSellado(null) });
    comp.abrirCierre();
    expect(comp.revelacion()).toBeNull();
    expect(comp.gateCierre().ok).toBe(false);
  });

  it('⛔ [negativa] un API viejo que no manda el campo se lee como «nada sellado», no como sellado', () => {
    montar({
      saldo: vi.fn(() => of({
        ...SALDO, sin_corte_abierto: false,
        corte_abierto: { id: 'c1', folio: 'CC-2026-00001', fondo_inicial: 3327.5, ya_reconto: false },
      } as unknown as SaldoResponse)),
    });
    comp.abrirCierre();
    expect(comp.revelacion()).toBeNull();
    expect(comp.gateCierre().ok).toBe(false);
  });

  it('un conteo ya recontado NO vuelve a ofrecer recontar', () => {
    montar({
      saldo: conSellado({
        contado: 3653.5, esperado: 3700, diferencia: -46.5,
        veredicto: 'falta', ya_reconto: true,
      }),
    });
    comp.abrirCierre();
    expect(comp.puedeRecontar()).toBe(false);
    // Se cierra igual: un faltante se registra, no se esconde.
    expect(comp.gateCierre().ok).toBe(true);
  });

  it('`sin_medir` tiene etiqueta propia — no cae al crudo ni a «no cuadra»', () => {
    montar();
    const t = comp.etiquetaVeredicto('sin_medir');
    expect(t).not.toBe('sin_medir');
    expect(t.toLowerCase()).not.toContain('no cuadra');
  });

  // ── `[CGP-V.12]` El esperado cambió desde el conteo (el 409 de `[CGP-L.2]`) ──────────────────
  //
  // Si entra un movimiento de la jornada después de contar, el servidor ya no firma otro esperado
  // en silencio: responde 409. Sin esto la pantalla lo mostraba en un aviso de 7 s y no había forma
  // de confirmar — un callejón nuevo, el mismo tipo de defecto que trabó el 12-oct.
  const conflicto409 = () => throwError(() => ({
    status: 409,
    error: {
      motivo: 'esperado_cambio', esperado_mostrado: 1500, esperado_actual: 1800,
      message: 'El esperado cambió desde que se contó: se mostró $1,500.00 y ahora da $1,800.00.',
    },
  }));
  const sellado1500 = { contado: 1500, esperado: 1500, diferencia: 0, veredicto: 'cuadra', ya_reconto: false };

  it('⛔ [CGP-V.12] si el esperado cambió, el diálogo lo MUESTRA con las dos cifras y no se cierra', () => {
    montar({ saldo: conSellado(sellado1500), cerrarCorte: vi.fn(conflicto409) });
    comp.abrirCierre();
    comp.cerrarCorte();
    expect(comp.conflictoEsperado()).toMatchObject({ mostrado: 1500, actual: 1800 });
    expect(comp.cierreAbierto()).toBe(true);
    // El primer intento va SIN confirmación: nadie vio todavía el esperado nuevo.
    expect(svc['cerrarCorte'].mock.calls[0][4]).toBeUndefined();
  });

  it('[CGP-V.12] confirmar reenvía el esperado que la persona VIO, y cierra', () => {
    const cerrar = vi.fn()
      .mockImplementationOnce(conflicto409)
      .mockImplementationOnce(() => of({ id: 'c1', estado: 'cerrado', totales: {} }));
    montar({ saldo: conSellado(sellado1500), cerrarCorte: cerrar });
    comp.abrirCierre();
    comp.cerrarCorte();     // 409: aparece el conflicto
    comp.cerrarCorte();     // la persona confirma
    expect(cerrar).toHaveBeenCalledTimes(2);
    expect(cerrar.mock.calls[1][4]).toBe(1800);
    expect(comp.conflictoEsperado()).toBeNull();
    expect(comp.cierreAbierto()).toBe(false);
  });

  it('⛔ [CGP-V.12] otro error NO se confunde con el conflicto: sigue yendo al aviso', () => {
    montar({
      saldo: conSellado(sellado1500),
      cerrarCorte: vi.fn(() => throwError(() => ({ status: 400, error: { message: 'El conteo de este corte ya está sellado.' } }))),
    });
    comp.abrirCierre();
    comp.cerrarCorte();
    expect(comp.conflictoEsperado()).toBeNull();
  });

  it('[CGP-V.12] reabrir el diálogo limpia un conflicto viejo', () => {
    montar({ saldo: conSellado(sellado1500), cerrarCorte: vi.fn(conflicto409) });
    comp.abrirCierre();
    comp.cerrarCorte();
    expect(comp.conflictoEsperado()).not.toBeNull();
    comp.abrirCierre();
    expect(comp.conflictoEsperado()).toBeNull();
  });
});
  // ── `[CGP-V.3]` Las jornadas atrasadas se cierran desde la pantalla, y en orden ─────────────────
  //
  // El 13 y el 14-oct no tenían camino: la pantalla SIEMPRE abría el corte de hoy, y abrir hoy
  // primero deja huérfanos a los días de atrás — `[CGP-L.4]` rechaza abrir una jornada anterior a un
  // corte que ya existe. El botón abre la atrasada más vieja y lo DICE en su etiqueta.
  describe('[CGP-V.3] jornadas atrasadas', () => {
    const pendientes = (jornadas: Array<{ fecha: string; movimientos: number }>, hoy = '2026-10-14') =>
      vi.fn(() => of({ sucursal: '00', hoy, inicio_libro: '2026-10-12', jornadas, alcance: 'cajon' as const }));
    const DOS = [{ fecha: '2026-10-12', movimientos: 3 }, { fecha: '2026-10-13', movimientos: 5 }];
    const sinCorte = () => vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true }));
    const fechaAbierta = () => (svc['abrirCorte'].mock.calls[0][0] as { fecha: string }).fecha;
    const falla = (status: number) => vi.fn(() => throwError(() => ({ status, error: {} })));

    it('⭐ con jornadas atrasadas, rendir cuentas abre la MÁS VIEJA, no la de hoy', () => {
      montar({ saldo: sinCorte(), jornadasPendientes: pendientes(DOS) });
      comp.cerrarJornada();
      expect(svc['abrirCorte']).toHaveBeenCalledTimes(1);
      expect(fechaAbierta()).toBe('2026-10-12');
      expect(comp.cierreAbierto()).toBe(true);   // y sigue derecho al conteo, como siempre
    });

    it('el botón lo dice, y el aviso nombra cada jornada y el orden', () => {
      const fx = montarJornada({ saldo: sinCorte(), jornadasPendientes: pendientes(DOS) });
      const panel: string = fx.nativeElement.querySelector('.cg-conc').textContent;
      expect(panel).toContain('Rendir cuentas del 12-oct');
      expect(panel).toContain('13-oct');
      expect(panel).toContain('en orden');
    });

    it('el subtítulo avisa sin tener que abrir la ventana', () => {
      montar({ saldo: sinCorte(), jornadasPendientes: pendientes(DOS) });
      expect(comp.subtituloJornada()).toContain('2 jornadas sin corte desde el 12-oct');
    });

    it('[negativa] sin atrasadas abre HOY, y el hoy es el del servidor', () => {
      // Un día que no puede ser el del navegador: si saliera `todayMx()`, la prueba lo atrapa. El
      // servidor rechaza una fecha futura con SU reloj, así que es el reloj que hay que usar.
      montar({ saldo: sinCorte(), jornadasPendientes: pendientes([], '2031-01-15') });
      comp.cerrarJornada();
      expect(fechaAbierta()).toBe('2031-01-15');
    });

    it('⛔ [negativa] sin saber si hay atrasadas NO se abre el corte de hoy: se reintenta', () => {
      // Abrir hoy a ciegas puede dejar huérfanas las de atrás, y eso no se deshace desde aquí.
      const fx = montarJornada({ saldo: sinCorte(), jornadasPendientes: falla(500) });
      comp.cerrarJornada();
      expect(svc['abrirCorte']).not.toHaveBeenCalled();
      const panel: string = fx.nativeElement.querySelector('.cg-conc').textContent;
      expect(panel).toContain('Reintentar');
      expect(panel).not.toContain('rendir cuentas');

      const antes = svc['jornadasPendientes'].mock.calls.length;
      comp.reintentarCierre();
      expect(svc['jornadasPendientes'].mock.calls.length).toBe(antes + 1);
    });

    it('[negativa] un servidor que no conoce la ruta (404) abre hoy, como antes', () => {
      // Un API anterior a `[CGP-L.4]` no lista jornadas, pero tampoco tiene la regla que las deja
      // huérfanas: abrir hoy ahí es lo que ya pasaba. Trabar el cierre por un 404 sería peor.
      montar({ saldo: sinCorte(), jornadasPendientes: falla(404) });
      comp.cerrarJornada();
      expect(fechaAbierta()).toBe(todayMx());
    });

    // ⛔ `[CGS.14]` El candado se DICE antes de teclear: qué pasa y qué lo destraba, con el botón a la mano.
    it('con la caja bloqueada, el aviso abre la pantalla con la frase y lleva a rendir cuentas', () => {
      const fx = montarJornada({
        saldo: sinCorte(), jornadasPendientes: pendientes([{ fecha: '2026-10-20', movimientos: 30 }]),
        candado: vi.fn(() => of({
          bloqueado: true, motivo: 'jornada_sin_corte', jornada: '2026-10-20', activo: true, hoy: todayMx(),
          texto: 'No se puede capturar: la jornada del 20/10/2026 tiene 30 movimiento(s) y no tiene corte cerrado.',
          con_llave: null, pueden_recibir_llave: [],
        })),
      });
      const aviso = fx.nativeElement.querySelector('.cg-candado');
      expect(aviso).not.toBeNull();
      expect(aviso.getAttribute('role')).toBe('alert');
      expect(aviso.textContent).toContain('20/10/2026');
      expect(aviso.textContent).toContain('Rendir cuentas de esa jornada');
    });

    // `[CGS.18]` Lo que la supervisora devolvió se ve al entrar, y se responde ahí mismo.
    it('un corte observado aparece al entrar con su motivo, y Responder lo manda al servidor', () => {
      const responderCorte = vi.fn(() => of({ id: 'c8', estado: 'cerrado' }));
      const fx = montarJornada({
        saldo: sinCorte(), jornadasPendientes: pendientes([]), responderCorte,
        cortes: vi.fn(() => of({ rows: [{
          id: 'c8', folio: 'CC-2026-00008', fecha: '2026-10-20', estado: 'observado',
          observed_by_username: 'maria_gutierrez', observacion: 'Faltan 500 y nadie lo explica',
        }], limit: 50 })),
      });
      const aviso: string = fx.nativeElement.textContent;
      expect(aviso).toContain('Faltan 500 y nadie lo explica');
      expect(aviso).toContain('CC-2026-00008');

      comp.abrirRespuesta(comp.observados()[0]);
      comp.textoRespuesta.set('corto');
      comp.enviarRespuesta();
      expect(responderCorte).not.toHaveBeenCalled();   // [negativa] menos de 10 caracteres no se manda

      comp.textoRespuesta.set('Se pagó un flete de 500 sin capturarlo');
      comp.enviarRespuesta();
      expect(responderCorte).toHaveBeenCalledWith('c8', 'Se pagó un flete de 500 sin capturarlo');
    });

    it('[negativa] con la caja libre no hay aviso de candado', () => {
      const fx = montarJornada({ saldo: sinCorte(), jornadasPendientes: pendientes([]) });
      expect(fx.nativeElement.querySelector('.cg-candado')).toBeNull();
    });

    it('con un corte atrasado ABIERTO va a ese corte, y el cierre dice de qué jornada es', () => {
      const fx = montarJornada({
        saldo: vi.fn(() => of({
          ...SALDO, sin_corte_abierto: false,
          corte_abierto: { id: 'c9', folio: 'CC-2026-00009', fecha: '2026-10-13', fondo_inicial: 500, ya_reconto: false },
        })),
        jornadasPendientes: pendientes([]),
      });
      const panel: string = fx.nativeElement.querySelector('.cg-conc').textContent;
      expect(panel).toContain('Rendir cuentas del 13-oct');

      comp.cerrarJornada();
      fx.detectChanges();
      expect(svc['abrirCorte']).not.toHaveBeenCalled();
      expect(comp.cierreAbierto()).toBe(true);
      expect(document.body.textContent).toContain('CC-2026-00009 · jornada del 13-oct');
    });

    it('al cerrar un corte se vuelve a medir: así aparece la siguiente atrasada', () => {
      montar({
        saldo: vi.fn(() => of({
          ...SALDO, sin_corte_abierto: false,
          corte_abierto: {
            id: 'c9', folio: 'CC-2026-00009', fecha: '2026-10-12', fondo_inicial: 500, ya_reconto: false,
            conteo_sellado: { contado: 1500, esperado: 1500, diferencia: 0, veredicto: 'cuadra', ya_reconto: false },
          },
        } as unknown as SaldoResponse)),
        jornadasPendientes: pendientes([{ fecha: '2026-10-13', movimientos: 5 }]),
        cerrarCorte: vi.fn(() => of({ id: 'c9', estado: 'cerrado', totales: {} })),
      });
      const antes = svc['jornadasPendientes'].mock.calls.length;
      comp.abrirCierre();
      comp.cerrarCorte();
      expect(svc['cerrarCorte']).toHaveBeenCalled();
      expect(svc['jornadasPendientes'].mock.calls.length).toBeGreaterThan(antes);
    });
    it('⛔ [negativa] la otra puerta — declarar el fondo — tampoco abre hoy por encima de una atrasada', () => {
      // «Declarar con cuánto arrancó la caja» abre el corte desde su propio diálogo. Si esa puerta
      // abriera hoy, dejaría huérfanas a las atrasadas igual que el botón principal.
      montar({ saldo: sinCorte(), jornadasPendientes: pendientes(DOS) });
      comp.abrirApertura();
      comp.fondoInicial.set(800);
      comp.abrirCorte();
      expect(fechaAbierta()).toBe('2026-10-12');
    });

    it('⛔ [negativa] por esa puerta, sin saber si hay atrasadas tampoco se abre nada', () => {
      montar({ saldo: sinCorte(), jornadasPendientes: falla(500) });
      comp.abrirApertura();
      comp.fondoInicial.set(800);
      comp.abrirCorte();
      expect(svc['abrirCorte']).not.toHaveBeenCalled();
    });
  });
  // ── `[CGP-V.1]` + `[CGP-V.2]` Los pasos del corte, y la reja después de revelar ─────────────────
  //
  // V2 (diagnóstico): el callejón de CG.160 seguía siendo posible SIN recargar. Después de sellar no
  // se volvía a pedir el saldo y `abrirCierre()` borraba lo sellado en la sesión, así que cerrar el
  // diálogo y reabrirlo volvía a ofrecer «Guardar conteo» (400). V1: la reja seguía editable después
  // de revelar y «Cerrar corte» mandaba lo tecleado.
  describe('[CGP-V.1][CGP-V.2] el corte paso a paso', () => {
    const abierto = (conteo_sellado: unknown = null) => ({
      ...SALDO, sin_corte_abierto: false,
      corte_abierto: { id: 'c1', folio: 'CC-2026-00007', fecha: todayMx(), fondo_inicial: 500, ya_reconto: false, conteo_sellado },
    } as unknown as SaldoResponse);
    const TOTALES_CUADRA = {
      ingresos: 1000, gastos: 0, depositos: 0, esperado: 1500, contado: 1500, diferencia: 0, veredicto: 'cuadra',
      movimientos: 1, cancelados: 0, ingresos_anclados: 0, ingresos_capturados: 1000, cobertura_ingreso: 0,
    };
    const SELLADO_FALTA = {
      contado: 1400, esperado: 1500, diferencia: -100, veredicto: 'falta', ya_reconto: false,
      desglose: [{ denom_key: '500', denominacion: 500, piezas: 2 }, { denom_key: '200', denominacion: 200, piezas: 2 }],
      morralla: 0,
    };
    const den = (key: string) => comp.reja.find((d) => d.key === key)!;
    const contar = () => vi.fn(() => of({ corte_id: 'c1', totales: TOTALES_CUADRA, puede_recontar: false }));
    const cerrado = () => vi.fn(() => of({ id: 'c1', estado: 'cerrado', totales: {} }));

    it('⛔ V2: sellar, cerrar el diálogo y reabrirlo NO vuelve a ofrecer «Guardar conteo»', () => {
      // El saldo sigue diciendo «sin sellar»: es justo el caso en que no se volvió a pedir.
      montar({ saldo: vi.fn(() => of(abierto(null))), contarCorte: contar() });
      comp.abrirCierre();
      comp.setPiezasCorte(den('500'), 3);
      comp.sellarConteo();
      comp.cierreAbierto.set(false);
      comp.abrirCierre();
      expect(comp.revelacion()?.contado).toBe(1500);
      expect(comp.rejaEditable()).toBe(false);
      expect(comp.gateCierre().ok).toBe(true);
    });

    it('después de sellar se vuelve a pedir el saldo: el estado sale del servidor', () => {
      montar({ saldo: vi.fn(() => of(abierto(null))), contarCorte: contar() });
      comp.abrirCierre();
      const antes = svc['saldo'].mock.calls.length;
      comp.setPiezasCorte(den('500'), 3);
      comp.sellarConteo();
      expect(svc['saldo'].mock.calls.length).toBe(antes + 1);
    });

    it('revelado, la reja muestra LO SELLADO por el servidor y deja de teclearse', () => {
      montar({ saldo: vi.fn(() => of(abierto(SELLADO_FALTA))) });
      comp.abrirCierre();
      expect(comp.rejaEditable()).toBe(false);
      expect(comp.piezasSelladasDe(den('500'))).toBe(2);
      expect(comp.piezasSelladasDe(den('200'))).toBe(2);
      expect(comp.piezasSelladasDe(den('100'))).toBe(0);
    });

    it('⛔ cerrar después de revelar manda la reja VACÍA: lo que se firma es lo sellado', () => {
      montar({ saldo: vi.fn(() => of(abierto(null))), contarCorte: contar(), cerrarCorte: cerrado() });
      comp.abrirCierre();
      comp.setPiezasCorte(den('500'), 3);
      comp.sellarConteo();
      comp.cerrarCorte();
      expect(svc['cerrarCorte']).toHaveBeenCalledTimes(1);
      expect(svc['cerrarCorte'].mock.calls[0][1]).toEqual([]);
      expect(svc['cerrarCorte'].mock.calls[0][2]).toBe(0);
    });

    it('⛔ si la relectura del saldo falla después de sellar, el corte del diálogo se puede cerrar igual', () => {
      let falla = false;
      const saldo = vi.fn(() => (falla ? throwError(() => ({ status: 500, error: {} })) : of(abierto(null))));
      montar({ saldo, contarCorte: contar(), cerrarCorte: cerrado() });
      comp.abrirCierre();
      comp.setPiezasCorte(den('500'), 3);
      falla = true;
      comp.sellarConteo();
      expect(comp.saldoResp()).toBeNull();     // la relectura falló de verdad
      comp.cerrarCorte();
      expect(svc['cerrarCorte']).toHaveBeenCalledTimes(1);
      expect(svc['cerrarCorte'].mock.calls[0][0]).toBe('c1');
    });

    it('Recontar abre la reja VACÍA, pide motivo, y mientras tanto no se cierra', () => {
      const recontarCorte = vi.fn(() => of({ corte_id: 'c1', totales: TOTALES_CUADRA, puede_recontar: false }));
      montar({ saldo: vi.fn(() => of(abierto(SELLADO_FALTA))), recontarCorte, cerrarCorte: cerrado() });
      comp.abrirCierre();
      expect(comp.ofreceRecontar()).toBe(true);
      comp.empezarReconteo();
      expect(comp.rejaEditable()).toBe(true);
      expect(comp.conteoCorte()).toEqual([]);

      comp.cerrarCorte();
      expect(svc['cerrarCorte']).not.toHaveBeenCalled();   // a mitad del reconteo firmaría el primero

      comp.setPiezasCorte(den('500'), 3);
      comp.recontar();
      expect(recontarCorte).not.toHaveBeenCalled();         // sin motivo no hay reconteo
      comp.motivoReconteo.set('Faltó contar el billete de 500');
      comp.recontar();
      expect(recontarCorte).toHaveBeenCalledTimes(1);
      expect(comp.recontando()).toBe(false);
      expect(comp.puedeRecontar()).toBe(false);             // era el único
      expect(comp.revelacion()?.contado).toBe(1500);
    });

    it('«Volver al conteo sellado» descarta lo tecleado y vuelve a la reja de sólo lectura', () => {
      montar({ saldo: vi.fn(() => of(abierto(SELLADO_FALTA))) });
      comp.abrirCierre();
      comp.empezarReconteo();
      comp.setPiezasCorte(den('100'), 3);
      comp.cancelarReconteo();
      expect(comp.rejaEditable()).toBe(false);
      expect(comp.conteoCorte()).toEqual([]);
    });

    it('⛔ un API que no manda el desglose: la reja NO se pinta en blanco, se declara', () => {
      const { desglose: _d, morralla: _m, ...sinDesglose } = SELLADO_FALTA;
      montar({ saldo: vi.fn(() => of(abierto(sinDesglose))) });
      comp.abrirCierre();
      expect(comp.rejaEditable()).toBe(false);
      expect(comp.desgloseSellado()).toBeNull();
    });

    /**
     * ⚠️ 2026-10-16 — ESTA PRUEBA CAMBIÓ DE EJEMPLO, NO DE REGLA. Usaba el billete de $1,000
     * como «la pieza que la reja no tiene», y desde hoy la reja SÍ lo tiene (pedido de Edgar).
     *
     * ⭐ Y al buscarle reemplazo salió un hecho que vale anotar: la caja ahora ofrece **las 12
     * llaves del catálogo compartido**, así que ya no existe ninguna denominación catalogada
     * fuera de la reja. La regla igual sigue viva, porque el desglose sellado viene de la BASE
     * y su CHECK no se deriva de este catálogo: un corte viejo, o una llave que el catálogo
     * deje de publicar mañana, entran por acá igual. Por eso el ejemplo pasa a una llave que
     * NO está en el catálogo en vez de a una que todavía no se ofrecía.
     */
    it('⛔ un desglose con una pieza que la reja no tiene se declara, no se pinta a medias', () => {
      // La reja de sólo lectura no tendría dónde ponerla, y lo que se ve no sumaría lo sellado.
      montar({ saldo: vi.fn(() => of(abierto({
        ...SELLADO_FALTA, contado: 5400,
        desglose: [{ denom_key: '5000', denominacion: 5000, piezas: 1 }, { denom_key: '200', denominacion: 200, piezas: 2 }],
      }))) });
      comp.abrirCierre();
      expect(comp.rejaEditable()).toBe(false);
      expect(comp.desgloseSellado()).toBeNull();
    });

    it('⭐ [control] el MISMO desglose, con el $1,000 que la reja ya ofrece, SÍ se pinta', () => {
      // Sin este control la prueba de arriba pasaría aunque el guard rechazara todo: hay que
      // ver que distingue «llave desconocida» de «llave que la reja tiene».
      montar({ saldo: vi.fn(() => of(abierto({
        ...SELLADO_FALTA, contado: 1400,
        desglose: [{ denom_key: '1000', denominacion: 1000, piezas: 1 }, { denom_key: '200', denominacion: 200, piezas: 2 }],
      }))) });
      comp.abrirCierre();
      expect(comp.desgloseSellado(), 'el $1,000 ya es parte de la reja: tiene dónde pintarse').not.toBeNull();
    });

    it('abrir desde «rendir cuentas»: el diálogo ya sabe qué corte es aunque el saldo no haya vuelto', () => {
      // El saldo no trae el corte recién abierto (todavía no volvió): sale de la respuesta de abrir.
      montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
      comp.cerrarJornada();
      expect(comp.cierreAbierto()).toBe(true);
      expect(comp.rotuloCorte()).toContain('CC-2026-00001');
    });

    // V.1 — el paso, en la página.
    it('el paso de la página sin corte abierto es abrir', () => {
      montar();
      expect(comp.pasoPagina()).toBe('abrir');
    });

    it('el paso de la página con el corte abierto y sin sellar es contar', () => {
      montar({ saldo: vi.fn(() => of(abierto(null))) });
      expect(comp.pasoPagina()).toBe('contar');
    });

    it('el paso de la página con un conteo sellado que cuadra es cerrar', () => {
      montar({ saldo: vi.fn(() => of(abierto({ ...SELLADO_FALTA, veredicto: 'cuadra', diferencia: 0, esperado: 1400 }))) });
      expect(comp.pasoPagina()).toBe('cerrar');
    });

    it('con diferencia y el reconteo sin usar, el paso es revisar la diferencia', () => {
      montar({ saldo: vi.fn(() => of(abierto(SELLADO_FALTA))) });
      expect(comp.pasoPagina()).toBe('revisar');
    });

    it('cerrado y sin autorizar: el paso es autorizar, y nombra el folio', () => {
      montar({
        cortes: vi.fn(() => of({ rows: [
          { id: 'c0', folio: 'CC-2026-00006', fecha: '2026-10-12', sucursal: '00', estado: 'autorizado' },
          { id: 'c9', folio: 'CC-2026-00009', fecha: '2026-10-13', sucursal: '00', estado: 'cerrado' },
        ] })),
      });
      expect(comp.pasoPagina()).toBe('autorizar');
      expect(comp.textoPasoPagina()).toContain('CC-2026-00009');
    });

    it('⛔ [negativa] sin saldo medido la página no afirma ningún paso', () => {
      montar({ saldo: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
      expect(comp.pasoPagina()).toBeNull();
    });
  });
  // ── `[CGP-V.4]` Midiendo no es «sin medir» ───────────────────────────────────────────────────
  //
  // Mientras el saldo cargaba, la pantalla decía «Corte sin medir» y ofrecía «Reintentar»: y
  // reintentar mandaba MÁS lecturas contra el mismo límite de 10 por segundo que la frenaba.
  describe('[CGP-V.4] el saldo midiendo', () => {
    const enVuelo = () => vi.fn(() => new Subject());
    const falla500 = () => vi.fn(() => throwError(() => ({ status: 500, error: {} })));
    const panel = (fx: { nativeElement: HTMLElement }) => fx.nativeElement.querySelector('.cg-conc')?.textContent ?? '';

    it('mientras el saldo mide no dice «sin medir» ni ofrece «Reintentar»: el botón espera', () => {
      const fx = montarJornada({ saldo: enVuelo() });
      expect(comp.cargandoSaldo()).toBe(true);
      expect(comp.textoSaldoUI()).toContain('midiendo');
      expect(comp.subtituloJornada()).toContain('midiendo si hay corte abierto');
      expect(panel(fx)).not.toContain('Corte sin medir');
      expect(panel(fx)).not.toContain('Reintentar');
    });

    it('⛔ con el saldo en vuelo, rendir cuentas no abre nada', () => {
      montarJornada({ saldo: enVuelo() });
      comp.cerrarJornada();
      expect(svc['abrirCorte']).not.toHaveBeenCalled();
    });

    it('⛔ la otra puerta tampoco: declarar el fondo sin saldo medido no abre', () => {
      montarJornada({ saldo: falla500() });
      comp.abrirApertura();
      comp.fondoInicial.set(800);
      comp.abrirCorte();
      expect(svc['abrirCorte']).not.toHaveBeenCalled();
    });

    it('si el saldo FALLA, entonces sí: sin medir y «Reintentar»', () => {
      const fx = montarJornada({ saldo: falla500() });
      expect(comp.cargandoSaldo()).toBe(false);
      expect(comp.saldoSinMedir()).toBe(true);
      expect(panel(fx)).toContain('Corte sin medir');
      expect(panel(fx)).toContain('Reintentar');
    });
  });
  // ── `[CGP-V.5]` El error se queda donde se hizo la acción, con su frase ────────────────────────
  //
  // Antes todo salía en un aviso de 7 s, el diálogo de cierre no conservaba ningún error, y un 403
  // se pintaba «No tenés permiso» aunque el servidor dijera que era la doble llave.
  describe('[CGP-V.5] el error se queda donde se hizo la acción', () => {
    const abierto = () => vi.fn(() => of({
      ...SALDO, sin_corte_abierto: false,
      corte_abierto: { id: 'c1', folio: 'CC-2026-00007', fecha: todayMx(), fondo_inicial: 500, ya_reconto: false, conteo_sellado: null },
    } as unknown as SaldoResponse));
    const falla = (status: number, message: string) => vi.fn(() => throwError(() => ({ status, error: { message } })));
    const panel = (fx: { nativeElement: HTMLElement }) => fx.nativeElement.querySelector('.cg-conc')?.textContent ?? '';

    it('sellar falla: la frase del servidor queda en el diálogo, que sigue abierto', () => {
      montar({ saldo: abierto(), contarCorte: falla(400, 'La reja trae una denominación que no existe.') });
      comp.abrirCierre();
      comp.setPiezasCorte(comp.reja.find((d) => d.key === '500')!, 1);
      comp.sellarConteo();
      expect(comp.cierreAbierto()).toBe(true);
      expect(comp.errorCierre()).toContain('La reja trae una denominación que no existe.');
    });

    it('reabrir el diálogo limpia el error viejo', () => {
      montar({ saldo: abierto(), contarCorte: falla(400, 'La reja trae una denominación que no existe.') });
      comp.abrirCierre();
      comp.setPiezasCorte(comp.reja.find((d) => d.key === '500')!, 1);
      comp.sellarConteo();
      comp.abrirCierre();
      expect(comp.errorCierre()).toBeNull();
    });

    it('⛔ autorizar con el 403 de la doble llave: SU frase, en la fila de ese corte', () => {
      montar({
        cortes: vi.fn(() => of({ rows: [
          { id: 'c9', folio: 'CC-2026-00009', fecha: '2026-10-13', sucursal: '00', estado: 'cerrado', closed_by: null },
        ] })),
        autorizarCorte: falla(403, 'Quien cerró el corte no puede autorizarlo: tiene que hacerlo otra persona.'),
      });
      comp.autorizar(comp.cortes()[0]);
      expect(comp.errorAutorizar()).toEqual({
        id: 'c9', texto: 'Quien cerró el corte no puede autorizarlo: tiene que hacerlo otra persona.',
      });
    });

    it('abrir desde «rendir cuentas» falla: la frase queda junto al botón del cierre', () => {
      const fx = montarJornada({
        saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })),
        abrirCorte: falla(400, 'El 12-oct ya tiene su corte: CC-2026-00001.'),
      });
      comp.cerrarJornada();
      fx.detectChanges();
      expect(comp.errorApertura()).toContain('CC-2026-00001');
      expect(panel(fx)).toContain('CC-2026-00001');
    });
  });
  // ── `[CGP-V.7]` Lo no medido se dice, y las fechas no salen crudas ───────────────────────────
  describe('[CGP-V.7] lo no medido se dice', () => {
    it('⛔ cancelados sin monto medido: dice «sin medir», no $0.00', () => {
      montar({ libro: vi.fn(() => of({ ...LIBRO, kpi: { ...LIBRO.kpi, cancelados: 2, monto_cancelado: null } })) });
      const sub = comp.kpis().find((k) => k.label === 'Movimientos')?.sub ?? '';
      expect(sub).toContain('2 cancelados');
      expect(sub).toContain('sin medir');
      expect(sub).not.toContain('$0.00');
    });

    it('cancelados con monto medido: el monto', () => {
      montar({ libro: vi.fn(() => of({ ...LIBRO, kpi: { ...LIBRO.kpi, cancelados: 1, monto_cancelado: 250 } })) });
      const sub = comp.kpis().find((k) => k.label === 'Movimientos')?.sub ?? '';
      expect(sub).toContain('$250.00');
    });
  });
  // ── `[CGP-V.6]` Los botones dependen del permiso, y lo dicen ────────────────────────────────
  //
  // Quien sólo tenía VER veía «Rendir cuentas» y la fila del corte ofrecía «Autorizar» a quien no
  // podía: el clic terminaba en un 403. Sin permisos cargados no se bloquea: decide el servidor.
  describe('[CGP-V.6] los botones dependen del permiso', () => {
    const permisos = (p: Record<string, boolean>) => TestBed.inject(PermissionsService).load(p, 'cajero', 'servidor');
    const panel = (fx: { nativeElement: HTMLElement }) => fx.nativeElement.querySelector('.cg-conc')?.textContent ?? '';
    const CERRADO = { id: 'c9', folio: 'CC-2026-00009', fecha: '2026-10-13', sucursal: '00', estado: 'cerrado', closed_by: 'otro' };

    it('⛔ sólo con VER no se ofrece rendir cuentas, y se dice qué permiso falta', () => {
      const fx = montarJornada();
      permisos({ FINANCE_CAJA_VER: true });
      fx.detectChanges();
      expect(comp.puedeGestionar()).toBe(false);
      comp.cerrarJornada();
      expect(svc['abrirCorte']).not.toHaveBeenCalled();
      expect(panel(fx)).toContain('Capturar en Caja General');
      expect(panel(fx)).not.toContain('Cerrar jornada y rendir cuentas');
    });

    it('con GESTIONAR sí se rinde cuentas', () => {
      montarJornada();
      permisos({ FINANCE_CAJA_VER: true, FINANCE_CAJA_GESTIONAR: true });
      comp.cerrarJornada();
      expect(svc['abrirCorte']).toHaveBeenCalledTimes(1);
    });

    it('⛔ sin AUTORIZAR, la fila del corte cerrado no ofrece autorizar y dice por qué', () => {
      montar({ cortes: vi.fn(() => of({ rows: [CERRADO] })), autorizarCorte: vi.fn(() => of({})) });
      permisos({ FINANCE_CAJA_VER: true, FINANCE_CAJA_GESTIONAR: true });
      const g = comp.gateAutorizar(comp.cortes()[0]);
      expect(g.ok).toBe(false);
      expect(g.texto).toContain('Autorizar corte de Caja General');
      comp.autorizar(comp.cortes()[0]);
      expect(svc['autorizarCorte']).not.toHaveBeenCalled();
    });

    it('con AUTORIZAR, la fila ofrece autorizar', () => {
      montar({ cortes: vi.fn(() => of({ rows: [CERRADO] })) });
      permisos({ FINANCE_CAJA_VER: true, FINANCE_CAJA_AUTORIZAR: true });
      expect(comp.gateAutorizar(comp.cortes()[0]).ok).toBe(true);
    });

    it('⛔ sólo con VER: no se abre la captura ni se confirma el lote, y la barra dice por qué', () => {
      const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
      permisos({ FINANCE_CAJA_VER: true });
      fx.detectChanges();
      comp.capturaAbierta.set(false);   // puede llegar abierta por un borrador restaurado
      comp.abrirCaptura();
      expect(comp.capturaAbierta()).toBe(false);
      comp.marcarTodas(true);
      expect(comp.marcadas().length).toBe(2);   // que el freno sea el permiso, no una bandeja vacía
      comp.confirmarLote();
      expect(svc['confirmarLote']).not.toHaveBeenCalled();
      const barra: string = fx.nativeElement.querySelector('.cg-bar')?.textContent ?? '';
      expect(barra).toContain('Capturar en Caja General');
      expect(barra).not.toContain('Registrar movimiento');
    });

    it('permisos sin cargar: no se bloquea nada (el candado es el servidor)', () => {
      montar();
      expect(comp.puedeGestionar()).toBe(true);
      expect(comp.puedeAutorizarPorPermiso()).toBe(true);
    });
  });
  // ── `[CGP-V.9]` Contar cero con confirmación explícita ───────────────────────────────────────
  //
  // Con la caja en $0, «Guardar conteo» quedaba deshabilitado sin explicación y ese corte no se podía
  // cerrar nunca. «No se contó» y «se contó y no hay efectivo» son dos hechos: el segundo se declara.
  describe('[CGP-V.9] contar cero con confirmación', () => {
    const abierto = () => vi.fn(() => of({
      ...SALDO, sin_corte_abierto: false,
      corte_abierto: { id: 'c1', folio: 'CC-2026-00007', fecha: todayMx(), fondo_inicial: 0, ya_reconto: false, conteo_sellado: null },
    } as unknown as SaldoResponse));
    const contarCero = () => vi.fn(() => of({
      corte_id: 'c1', puede_recontar: false,
      totales: {
        ingresos: 0, gastos: 0, depositos: 0, esperado: 0, contado: 0, diferencia: 0, veredicto: 'cuadra',
        movimientos: 0, cancelados: 0, ingresos_anclados: 0, ingresos_capturados: 0, cobertura_ingreso: null,
      },
    }));
    const den = (key: string) => comp.reja.find((d) => d.key === key)!;
    const texto = (fx: { nativeElement: HTMLElement }) => document.body.textContent + fx.nativeElement.textContent;

    it('⛔ con la reja en cero y sin declarar no se sella, y la pantalla dice cómo se hace', () => {
      const fx = montar({ saldo: abierto(), contarCorte: contarCero() });
      comp.abrirCierre();
      fx.detectChanges();
      expect(comp.puedeSellar()).toBe(false);
      comp.sellarConteo();
      expect(svc['contarCorte']).not.toHaveBeenCalled();
      expect(texto(fx)).toContain('Conté y no hay efectivo');
    });

    it('declarando «conté y no hay efectivo» se sella en cero, y viaja la declaración', () => {
      montar({ saldo: abierto(), contarCorte: contarCero() });
      comp.abrirCierre();
      comp.ceroDeclarado.set(true);
      expect(comp.puedeSellar()).toBe(true);
      comp.sellarConteo();
      expect(svc['contarCorte'].mock.calls[0][3]).toBe(true);
      expect(comp.revelacion()?.contado).toBe(0);
    });

    it('⛔ si después se teclea una pieza, la declaración de cero deja de valer', () => {
      montar({ saldo: abierto(), contarCorte: contarCero() });
      comp.abrirCierre();
      comp.ceroDeclarado.set(true);
      comp.setPiezasCorte(den('500'), 1);
      expect(comp.ceroVigente()).toBe(false);
      comp.sellarConteo();
      expect(svc['contarCorte'].mock.calls[0][3]).toBe(false);
    });

    it('reabrir el diálogo olvida la declaración: se confirma cada vez', () => {
      montar({ saldo: abierto(), contarCorte: contarCero() });
      comp.abrirCierre();
      comp.ceroDeclarado.set(true);
      comp.abrirCierre();
      expect(comp.ceroDeclarado()).toBe(false);
    });
  });
  // ── `[CGP-V.11]` Deuda de diseño ──────────────────────────────────────────────────────────────
  describe('[CGP-V.11] deuda de diseño', () => {
    it('el motivo de «sin documento» es un pTextarea con su etiqueta, no un textarea crudo', () => {
      const fx = montar();
      comp.abrirCaptura();
      fx.detectChanges();
      const ta = (document.querySelector('#cg-sin-doc') ?? fx.nativeElement.querySelector('#cg-sin-doc')) as HTMLElement | null;
      expect(ta).not.toBeNull();
      expect(ta!.classList.contains('p-textarea')).toBe(true);
      expect(document.querySelector('label[for="cg-sin-doc"]') ?? fx.nativeElement.querySelector('label[for="cg-sin-doc"]')).not.toBeNull();
    });
  });
  /**
   * `[CGA11Y-O3b]` LA TIRA DE ACCESOS RAPIDOS.
   *
   * El eje es `doc_tipo` y el conteo viene DEL SERVIDOR. Contar las filas cargadas es el
   * defecto que [CG.30] midio: la bandeja publicaba «31 de 100» teniendo 1,887 en esa caja.
   */
  describe('[CGA11Y-O3b] la tira de accesos', () => {
    const CON_GRUPOS = {
      ...VACIA,
      grupos: [
        { doc_tipo: 'X-D-26', tipo: 'gasto', movimientos: 117, monto: 369989 },
        { doc_tipo: 'U-A-5', tipo: 'ingreso', movimientos: 6, monto: 109556 },
      ],
    };

    it('⭐ el acceso lleva su conteo, y Todos suma el universo', () => {
      montar({ movimientosPendientes: vi.fn(() => of(CON_GRUPOS as never)) });
      const ops = comp.opcionesGrupo();
      expect(ops[0]).toEqual({ label: 'Todos', value: '', count: 123 });
      expect(ops.find((o) => o.value === 'egreso')?.count).toBe(117);
      expect(ops.find((o) => o.value === 'deposito')?.count).toBe(6);
    });

    it('⛔ [negativa] sin grupos del servidor la tira NO se dibuja (ni con ceros)', () => {
      const fx = montar();
      expect(comp.grupos(), 'grupos tiene que quedar null, no []').toBeNull();
      expect(comp.opcionesGrupo()).toEqual([]);
      fx.detectChanges();
      const tiras = fx.nativeElement.querySelectorAll('app-segmented');
      const conGrupo = Array.from(tiras).filter((t) =>
        (t.getAttribute('ariaLabel') || t.getAttribute('aria-label') || '').includes('Grupo'));
      expect(conGrupo.length, 'se dibujo una tira sin medicion detras').toBe(0);
    });

    it('⛔ un doc_tipo desconocido entra como Sin clasificar, no se reparte', () => {
      montar({ movimientosPendientes: vi.fn(() => of({
        ...VACIA,
        grupos: [{ doc_tipo: 'X-D-99', tipo: 'gasto', movimientos: 4, monto: 100 }],
      } as never)) });
      const ops = comp.opcionesGrupo();
      expect(ops.find((o) => o.value === 'sin_clasificar')?.count).toBe(4);
      expect(ops.find((o) => o.value === 'egreso'), 'se colo en Egresos por empezar con X')
        .toBeUndefined();
    });

    it('elegir un grupo manda su doc_tipo al servidor', () => {
      const esp = vi.fn(() => of(CON_GRUPOS as never));
      montar({ movimientosPendientes: esp });
      comp.setGrupo('egreso');
      const ult = esp.mock.calls[esp.mock.calls.length - 1][0] as { doc_tipo?: string };
      expect(ult.doc_tipo).toBe('X-D-26');
    });
  });
  describe('[CGP-L.8] el comprobante del detalle', () => {
    it('lo recibido va al desglose y el cambio a su sección', () => {
      montar();
      const c = comp.comprobanteDeDetalle({
        id: 'm1', folio: 'ING-2026-00042', tipo: 'ingreso', fecha: '2026-10-12', sucursal: '00', monto: 380,
        denominaciones: [
          { denominacion: 500, piezas: 1, flujo: 'recibido' },
          { denominacion: 100, piezas: 1, flujo: 'devuelto' },
          { denominacion: 20, piezas: 1, flujo: 'devuelto' },
        ],
      } as never);
      expect(c.denominaciones).toEqual([{ denominacion: 500, piezas: 1 }]);
      expect(c.devuelto).toEqual([{ denominacion: 100, piezas: 1 }, { denominacion: 20, piezas: 1 }]);
      expect(c.monto).toBe(380);
    });
  });

  /**
   * Auditoría front-end del 2026-10-16. Cuatro arreglos que NINGUNA de las 288 pruebas de arriba
   * habría visto caer: no cambian lo que la pantalla calcula, cambian lo que ANUNCIA y lo que
   * hace al desmontarse. Sin candado se revierten en el siguiente rediseño sin que nadie note.
   */
  describe('[CG-A11Y] la cifra se dice y la pantalla se desmonta limpia', () => {
    /**
     * El bloque del total es la única salida del conteo y cambia en CADA tecla de la reja. Sin
     * región viva, quien usa lector de pantalla teclea once renglones y nunca se entera del
     * total ni del veredicto.
     */
    it('⭐ el total contado viaja en una región viva, con su veredicto', async () => {
      const fx = await capturaEnPantalla();
      contar({ 500: 1 });
      fx.detectChanges();

      const vivo = fx.nativeElement.querySelector('p.sr-only[aria-live]') as HTMLElement | null;
      expect(vivo, 'el bloque CONTADO no tiene región viva').not.toBeNull();
      // `polite` y no `assertive`: anuncia cuando la persona deja de teclear, no cada dígito.
      expect(vivo!.getAttribute('aria-live')).toBe('polite');
      // La cifra sin su veredicto no es un dato: se lee entera o no se lee.
      expect(vivo!.getAttribute('aria-atomic')).toBe('true');
      expect(vivo!.textContent).toContain('500');
      // Con un billete de $500 y sin documento elegido, el veredicto es «sin documento».
      expect(vivo!.textContent).toContain('Sin documento');
    });

    /**
     * La cola la mueve el socket: entran movimientos mientras la persona cuenta efectivo del
     * otro lado de la pantalla. Va sobre el `cg-lead` que ya existe, no en un `sr-only` aparte.
     */
    it('⭐ la cuenta de la cola se anuncia sola cuando el socket la mueve', () => {
      const fx = montar();
      const lead = fx.nativeElement.querySelector('.cg-lead') as HTMLElement | null;
      expect(lead, 'la cabecera de la cola no existe').not.toBeNull();
      expect(lead!.getAttribute('aria-live')).toBe('polite');
      expect(lead!.getAttribute('aria-atomic')).toBe('true');
    });

    /**
     * ⭐ La prueba NEGATIVA de la guarda: sin `takeUntilDestroyed`, esta respuesta tardía escribe
     * `rows()` en un componente que ya no está en pantalla.
     */
    it('⭐ una LECTURA que contesta tarde no escribe en el componente destruido', () => {
      const tarde = new Subject<LibroResponse>();
      const fx = montar({ libro: vi.fn(() => tarde.asObservable()) as never });

      // Todavía en vuelo: nadie contestó.
      expect(comp.rows().length).toBe(0);

      fx.destroy();
      tarde.next({ ...LIBRO, rows: [{ id: 'm-tarde' }] as never });

      // Con la guarda la suscripción ya no existe y el `next` nunca corre.
      expect(comp.rows().length, 'la respuesta tardía entró igual').toBe(0);
    });

    /**
     * ⭐ El debounce del autollenado NO lo cubre `takeUntilDestroyed`: la guarda vive en la
     * suscripción y acá todavía no hay suscripción — hay un `setTimeout` pendiente que dispara
     * la petición DESPUÉS. Se cancela el temporizador, que es donde está el pendiente.
     */
    it('⭐ salir dentro de los 350 ms del debounce no dispara el autollenado', () => {
      vi.useFakeTimers();
      try {
        const fx = montar();
        comp.abrirCaptura();
        comp.setF('beneficiario', 'MERENGUE LA MORENITA');
        const antes = (svc.autofill as ReturnType<typeof vi.fn>).mock.calls.length;

        comp.pedirPropuestaDebounced();
        fx.destroy();
        vi.advanceTimersByTime(400);

        expect((svc.autofill as ReturnType<typeof vi.fn>).mock.calls.length,
          'el debounce disparó la petición después de destruir la pantalla').toBe(antes);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
