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

import { CAJA_VENTANA_DIAS, CAJA_JORNADA_DIAS, denomDe, type Denominacion } from '@megadulces/contracts';
import { FinanzasCajaGeneralComponent } from './finanzas-caja-general.component';
 import { CONTEXT_HELP } from '../../../../shared/context-help/context-help.dictionary';
import {
  CashLedgerService, type CoberturaResponse, type LibroResponse, type SaldoResponse,
  type PendientesResponse, type Frecuente, type CajaKepler, type MovimientoPendiente,
  type ArqueoDia, type RecurrentesResponse,
} from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
import { CajaSocketService, type CajaEvent } from '../../caja-socket.service';
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
  let cajaSock: { connect: () => void; disconnect: () => void; change$: Subject<CajaEvent>; connected: () => boolean };

  function montar(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    cajaSock = { connect: vi.fn(), disconnect: vi.fn(), change$: new Subject<CajaEvent>(), connected: () => false };
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
    expect(bandeja!.querySelectorAll('p-select').length).toBe(2);   // ventana + caja
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
    const fixture = montar();
    comp.revelado.set({
      ingresos: 0, gastos: 0, depositos: 0, contado: 900, movimientos: 3, cancelados: 0,
      ingresos_anclados: 0, ingresos_capturados: 0, cobertura_ingreso: null, oculto: true,
    });
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

  // ⭐⭐ [CG.60] ESTA PRUEBA SE DA VUELTA, y es el punto de la entrega.
  //
  // Antes exigía que el panel se ENSANCHARA al capturar (`.cg-split-capturando`, 24rem → 42rem).
  // Ese arreglo era correcto para el diseño viejo y aun así el ancho del arqueo quedaba colgado de
  // una condición — y esa condición ya falló dos veces: `[CG.49]` descubrió que el umbral de dos
  // columnas era inalcanzable por construcción, y `[CG.57]` que la consulta medía el panel en vez
  // de la columna. Las dos veces el defecto llegó a la pantalla con todos los gates en verde.
  //
  // Lo que se exige ahora es más fuerte: el arqueo tiene media pantalla SIEMPRE, y NADA de lo que
  // pase en la captura cambia el reparto. Una condición que no existe no se puede romper.

  it('el reparto de la pantalla NO depende de la captura: dos mitades, pase lo que pase', () => {
    const fx = montar();
    const split: HTMLElement | null = fx.nativeElement.querySelector('.cg-split');
    expect(split).not.toBeNull();
    const antes = split!.className;
    expect(split!.querySelectorAll(':scope > .cg-ap').length, 'dos apartados').toBe(2);

    comp.abrirCaptura();
    fx.detectChanges();
    expect(split!.className, 'capturar NO cambia el reparto').toBe(antes);
    expect(split!.querySelectorAll(':scope > .cg-ap').length).toBe(2);

    comp.cerrarConFoco(comp.capturaAbierta);
    fx.detectChanges();
    expect(split!.className).toBe(antes);
    // Y el apartado del arqueo sigue en pantalla con la captura cerrada: es media pantalla
    // reservada, no un panel que aparece y se va moviendo la lista debajo del cursor.
    expect(fx.nativeElement.querySelector('.cg-ap-arqueo')).not.toBeNull();
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
    expect(btn!.getAttribute('aria-expanded')).toBe('false');
    // ⭐ Plegar NO es esconder: cerrada ya publica el estado del día.
    expect(btn!.textContent).toContain('Tu jornada');
    expect(btn!.textContent).toContain(comp.subtituloJornada());

    // Y el cuadre del día NO está en el DOM mientras esté cerrada: ocupaba ~360px de la tarea.
    expect(fx.nativeElement.querySelector('.cg-conc')).toBeNull();
  });

  it('⛔ [negativa] abrir la jornada NO pierde nada: todo lo que se mudó sigue ahí', () => {
    const fx = montarJornada();
    expect(fx.nativeElement.querySelector('.cg-jornada-btn')!.getAttribute('aria-expanded')).toBe('true');

    // Los cinco bloques que se mudaron al desplegable. Si alguno se cayó en la mudanza, esto
    // se pone rojo — que es la diferencia entre MOVER y borrar.
    const panel: Element = fx.nativeElement.querySelector('.cg-jornada');
    expect(panel.querySelector('.cg-conc')).not.toBeNull();        // el cierre del día
    expect(panel.querySelector('.cg-rec')).not.toBeNull();         // los que repiten sin cuenta
    expect(panel.querySelector('.cg-historial')).not.toBeNull();   // el libro y los cortes
    expect(panel.textContent).toContain('Cerrar jornada');         // la acción de rendir cuentas
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

  it('el apartado 1 es el QUÉ y el 2 es el ARQUEO, en ese orden', async () => {
    const fx = montar();
    comp.abrirCaptura();
    await Promise.resolve();
    fx.detectChanges();

    const aps = Array.from(fx.nativeElement.querySelectorAll('.cg-split > .cg-ap')) as HTMLElement[];
    expect(aps.length).toBe(2);
    // Lado a lado y sin reordenar, el DOM ES el orden de lectura: primero qué se va a arquear,
    // después el arqueo. Es textualmente lo que pidió Edgar al aprobar el tablero.
    expect(aps[0].classList.contains('cg-ap-que')).toBe(true);
    expect(aps[1].classList.contains('cg-ap-arqueo')).toBe(true);
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
  it('son cinco billetes y SEIS monedas, más el resto suelto', async () => {
    const fx = await capturaEnPantalla();
    // 5 billetes + 6 monedas + 1 de resto suelto.
    expect(inputsPieza(fx).length).toBe(12);

    // Acotado AL BLOQUE del arqueo: sobre el innerHTML de la página entera, "$1,000" aparece
    // en la tira de KPIs y la prueba fallaba por un importe que no tiene nada que ver.
    const reja: string = fx.nativeElement.querySelector('.cg-arqueo').innerHTML;
    for (const b of ['$500', '$200', '$100', '$50', '$20']) expect(reja).toContain(b);
    expect(reja).toContain('50¢');          // el metal AHORA sí se desglosa
    expect(reja).toContain('Morralla');     // y queda el campo suelto para lo de menos de 50¢
    // El billete de $1,000 sigue fuera: esta caja no lo maneja.
    expect(reja).not.toContain('$1,000');
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
      expect(dev.length).toBe(11);                    // 5 billetes + 6 monedas
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
    expect(comp.piezasDe(den(100))).toBe(0);
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
    // El efectivo de la máquina va APARTE (denominacionesCajero), NO en la reja.
    expect(comp.piezasDe(den(500))).toBe(0);
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
    // El efectivo de la máquina va APARTE, no en la reja: la reja queda en cero (para la diferencia).
    expect(comp.piezasDe(den(500))).toBe(0);
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
    // ⚠️ `[CG.38]` Eran 5 (los billetes); hoy son 11 (5 billetes + 6 monedas). Lo que se afirma
    // —que la reja queda EDITABLE porque es la diferencia— no cambió.
    expect(denoms.length).toBe(11);
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
    // El efectivo del cajero va APARTE; la reja NO se toca (queda en cero, para la diferencia).
    expect(comp.piezasDe(den(500))).toBe(0);
    expect(comp.aporteCajero()).toBe(1300);
    expect(comp.f().monto).toBe(1300);   // monto = cajero + reja
    // El arqueo que va al servidor FUSIONA cajero + reja, para que cuadre con el monto (assertArqueo).
    expect(comp.denominacionesParaGuardar().reduce((a, d) => a + d.denominacion * d.piezas, 0)).toBe(1300);
    // Sin desglose tecleado, el arqueo YA cuadra (el del cajero) → no bloquea.
    comp.setF('kepler_cuenta', '201'); comp.setF('kepler_concepto', '001'); comp.setF('glosa', 'pago a cueritos');
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
    expect(comp.bloqueos()).toEqual([]);
    comp.guardar();
    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body['venta_credito']).toBe(1000);
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

  it('el neto del cajero se rotula «movimiento del día», NUNCA «saldo»', () => {
    // No es cosmética: el flujo acumulado da negativo porque el efectivo anterior al feed no se
    // conoce. Publicarlo como saldo sería publicar un número que no existe.
    const fx = montarJornada();
    const panel = panelCierre(fx);
    expect(panel).toContain('Movimiento del dia');
    expect(panel.toLowerCase()).not.toContain('saldo del cajero');
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
    const fx = montarJornada();
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
    const fx = montarJornada();
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

  it('la ventana por default es la MEDIDA, no la de pruebas ni «hoy»', () => {
    // Estuvo en 1 dia desde el 22-sep "para las pruebas de CG.21", con un comentario que decia
    // que tenia que volver. Se quedo ocho dias.
    //
    // `[CG.51]` Y ahora arranca en LA JORNADA (3 dias) por pedido de Edgar -- "por default solo
    // deben ser los movimientos del dia"-- pero NO en 1 dia, que es lo que esa frase pide al pie
    // de la letra. Medido contra prod el 2026-10-07 antes de cambiarlo: hoy = 0 movimientos, y el
    // dia mas reciente con volumen real es el 05/10. `fecha_valor` es la fecha del DOCUMENTO y el
    // ERP captura con 3 dias de mediana, asi que "hoy" abre la pantalla VACIA todos los dias.
    montar();
    expect(comp.ventanaDias()).toBe(CAJA_JORNADA_DIAS);
    expect(comp.ventanaDias()).not.toBe(1);
    expect(comp.ventanaDias()).toBeLessThan(CAJA_VENTANA_DIAS);
  });

  // ── [CG.51] El scroll: el historial se pliega, pero NO se esconde ─────────────────────────

  it('el historial arranca CERRADO: debajo del area de trabajo no hay 800px de archivo', () => {
    const fx = montarJornada();
    expect(comp.historialAbierto()).toBe(false);
    // La tabla del libro y la de los cortes no estan en el DOM mientras este cerrado.
    expect(fx.nativeElement.querySelector('app-metric-strip')).toBeNull();
  });

  it('cerrado NO es escondido: la cabecera dice el rango y cuanto hay adentro', () => {
    const fx = montarJornada();
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
    const fx = montarJornada();
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

  it('⭐ [el gesto unico] sin corte abierto, rendir cuentas pide el fondo y sigue al conteo', () => {
    // El arqueo exigia abrir el corte a las 8am para poder cerrarlo a las 7pm. Nadie lo hacia:
    // hay CERO cortes en produccion. Aca el gesto es uno solo, en el momento natural.
    montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
    comp.cerrarJornada();
    expect(comp.aperturaAbierta()).toBe(true);
    expect(comp.cierreAbierto()).toBe(false);

    comp.abrirCorte();                       // la persona confirma el fondo
    expect(svc['abrirCorte']).toHaveBeenCalled();
    expect(comp.cierreAbierto()).toBe(true); // …y cae DERECHO en el conteo
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

  it('⛔ [negativa] cancelar la apertura NO deja la intencion colgada', () => {
    // Sin esto, el siguiente corte que alguien abriera por su cuenta saltaria al conteo solo.
    montar({ saldo: vi.fn(() => of({ ...SALDO, corte_abierto: null, sin_corte_abierto: true })) });
    comp.cerrarJornada();
    comp.cancelarApertura();
    expect(comp.aperturaAbierta()).toBe(false);

    comp.abrirCorte();
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
    expect(comp.limitesAbiertos()).toBe(false);
    const panel: string = fx.nativeElement.querySelector('.cg-conc').innerHTML;
    expect(panel).toContain('Todavia no rendiste cuentas');   // el accionable, a la vista
    expect(panel).toContain('Que NO cubre este cuadre (2)');   // los permanentes, contados y plegados
    expect(panel).not.toContain('La cola de Kepler no entra');
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
    it('el panel de detalle es PERMANENTE: existe sin nada elegido, y dice que espera', () => {
      const fx = montar();
      const panel = fx.nativeElement.querySelector('.cg-detail');
      expect(panel, 'el detalle tiene que existir siempre, no aparecer al elegir').toBeTruthy();
      // ⚠️ `querySelector` encuentra el nodo aunque este ESCONDIDO, asi que existir no alcanza:
      // la primera version de esta prueba seguia en verde con un `[hidden]` puesto a proposito.
      // "Permanente" quiere decir VISIBLE sin nada elegido, no presente en el DOM.
      expect(panel.hidden, 'el detalle esta en el DOM pero escondido: eso no es permanente')
        .toBe(false);
      expect(comp.capturaAbierta()).toBe(false);
      // Vacio operacional: no "sin datos" a secas -- dice que hacer y ofrece una accion.
      expect(panel.textContent).toContain('Nada elegido');
      expect(panel.querySelector('p-button'), 'el vacio lleva su accion').toBeTruthy();
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

    it('⛔ el vacio del detalle no compite con el CTA de la cabecera: es la MISMA accion', () => {
      const fx = montar();
      const nada = fx.nativeElement.querySelector('.cg-detail-nada');
      const boton = nada.querySelector('button') as HTMLElement;
      expect(boton.textContent).toContain('Registrar uno nuevo');
      expect(boton.className, 'dos botones de marca para el mismo metodo')
        .toContain('p-button-secondary');
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
});
