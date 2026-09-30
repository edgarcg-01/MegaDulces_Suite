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

import { FinanzasCajaGeneralComponent } from './finanzas-caja-general.component';
import {
  CashLedgerService, type CoberturaResponse, type LibroResponse, type SaldoResponse,
  type PendientesResponse, type Frecuente, type CajaKepler, type MovimientoPendiente,
  type ArqueoDia,
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
  const contar = (piezas: Record<number, number>): void => {
    for (const [den, n] of Object.entries(piezas)) comp.setPiezas(Number(den), n);
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
    expect(html).toContain('Movimientos por confirmar');
    // Los tres p-select viven en el encabezado de la sección: si la sección se desmonta, la
    // persona queda encerrada con el filtro puesto y sin forma de sacarlo.
    expect(fixture.nativeElement.querySelectorAll('p-select').length).toBeGreaterThanOrEqual(3);
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
    comp.cierreAbierto.set(true);
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
    expect(comp.textoBandeja()).toContain('45 días');
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

  it('el input de Contado de una fila TRABADA NO está deshabilitado (rojo con el bug)', async () => {
    const fixture = montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    expect(comp.pendientes()[0].confirmable).toBe(false);

    // ⚠️ DOS cosas que esta prueba tuvo que aprender a la mala:
    //
    // 1. La aserción va contra el DOM a propósito. El defecto vivía en el `[disabled]` de la
    //    plantilla, así que un test que llame a `setContado()` directo pasa igual con el bug
    //    puesto: hay que preguntarle al control que la persona toca.
    // 2. Hay que ESPERAR un microtask. `NgModel` aplica el estado deshabilitado dentro de un
    //    `Promise.resolve().then(...)`, o sea DESPUÉS de `detectChanges()`. Sin este await la
    //    prueba salía verde con el bug reintroducido — verificado — y no probaba nada.
    await Promise.resolve();
    fixture.detectChanges();

    const input: HTMLInputElement | null = fixture.nativeElement.querySelector('input.cg-contado');
    expect(input).not.toBeNull();
    expect(input!.disabled).toBe(false);

    // Y el checkbox SÍ sigue deshabilitado: confirmar sin cuenta declarada no se puede.
    const check: HTMLInputElement | null = fixture.nativeElement.querySelector('tbody input.cg-check');
    expect(check!.disabled).toBe(true);
  });

  it('se puede contar una fila TRABADA (sin cuenta declarada)', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);
    expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(1100);
  });

  it('pero contarla NO la manda al lote: el servidor la rechazaría por no tener cuenta', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);
    expect(comp.marcadas()).toEqual([]);
  });

  it('«Capturar» abre el diálogo ANCLADO al documento, y el importe NACE EN CERO', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);
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
    // Pero el total tecleado en la bandeja NO se tira: queda a la vista para desglosarlo.
    expect(comp.contadoBandeja()).toBe(1100);
    expect(comp.bloqueos()).toContain('falta_desglose');
  });

  it('sin conteo, el importe NO lo hereda del documento: hay que contar', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    // Antes esto esperaba 1060 (el importe del ERP). Dar por bueno el importe del documento
    // vuelve el arqueo un trámite: se guardaba la cifra de Kepler sin haber contado nada.
    expect(comp.f().monto).toBe(0);
    expect(comp.montoContado()).toBe(null);
    expect(comp.contadoBandeja()).toBe(null);
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

  // ── 9 · PERSISTENCIA: lo tecleado sobrevive a un F5 ──────────────────────────────────────
  //
  // Punto 2 de la revisión de Edgar. Medido antes: la pantalla NO persistía nada — `contado` y
  // `seleccion` eran señales en memoria, así que un refresh borraba todo. Con hasta 100 filas
  // por pantalla y 12,207 pendientes, eso es mucho conteo tirado por una tecla.

  it('lo contado sobrevive a remontar la pantalla', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);

    // Se tira el componente y se vuelve a entrar, como un F5.
    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });

    expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(1100);
    expect(comp.restaurado()?.conteos).toBe(1);
  });

  it('NO revive un conteo cuya fila ya no está pendiente — y lo dice', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);

    // Otra persona lo confirmó: al volver, esa fila ya no está en la bandeja.
    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(VACIA)) });

    expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(null);
    expect(comp.marcadas()).toEqual([]);
    expect(comp.restaurado()?.descartados).toBe(1);
  });

  it('la clave lleva el USUARIO: en un navegador compartido no se cruzan los conteos', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);

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

    // Un conteo ajeno firmado con tu nombre no es un bug de comodidad.
    expect(f2.componentInstance.contadoDe(GASTO_TRABADO.origen_ref)).toBe(null);
    expect(f2.componentInstance.restaurado()).toBe(null);
  });

  it('confirmar el lote retira el borrador (ya está en el libro)', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);
    comp.marcar(GASTO_TRABADO.origen_ref, true);
    comp.confirmarLote();

    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(null);
  });

  it('un localStorage que revienta NO tumba la bandeja', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('QuotaExceeded'); };
    try {
      montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
      // El borrador es una red, no una dependencia: contar tiene que seguir funcionando.
      expect(() => comp.setContado(GASTO_TRABADO.origen_ref, 1100)).not.toThrow();
      expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(1100);
    } finally {
      Storage.prototype.setItem = real;
    }
  });

  it('descartar el borrador deja la bandeja limpia', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);
    comp.descartarBorrador();
    expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(null);

    TestBed.resetTestingModule();
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    expect(comp.contadoDe(GASTO_TRABADO.origen_ref)).toBe(null);
  });

  // ── 10 · TECLADO: contar es recorrer una columna ─────────────────────────────────────────
  //
  // Punto 3 de la revisión. Medido antes: el archivo no tenía UN SOLO manejo de foco (0 `focus()`,
  // 0 `keydown`). Con el Tab pelado son TRES saltos por fila —casilla, contado, Capturar—, o sea
  // 300 tabulaciones para las 100 filas que caben, con el efectivo en la mano.

  const inputsContado = (fx: { nativeElement: HTMLElement }) =>
    Array.from(fx.nativeElement.querySelectorAll('input.cg-contado')) as HTMLInputElement[];

  it('Enter en un Contado baja al siguiente de la columna', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const ins = inputsContado(fx);
    expect(ins.length).toBe(2);
    ins[0].focus();
    ins[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(document.activeElement).toBe(ins[1]);
  });

  it('la flecha arriba vuelve al anterior — y NO incrementa el importe', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const ins = inputsContado(fx);
    ins[1].focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    ins[1].dispatchEvent(ev);

    expect(document.activeElement).toBe(ins[0]);
    // En un input numérico la flecha SUBE el valor de a uno. En un importe de caja eso es cambiar
    // lo contado sin querer, así que cancelar el default es parte del arreglo.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('en la última fila, Enter no rompe nada', async () => {
    const fx = montar({ movimientosPendientes: vi.fn(() => of(CON_DOS)) });
    await Promise.resolve();
    fx.detectChanges();

    const ins = inputsContado(fx);
    ins[1].focus();
    expect(() => ins[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))).not.toThrow();
    expect(document.activeElement).toBe(ins[1]);
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

  it('son cinco billetes —500, 200, 100, 50, 20— más Morralla, y ninguna moneda suelta', async () => {
    const fx = await capturaEnPantalla();
    // 5 renglones de billete + 1 de morralla.
    expect(inputsPieza(fx).length).toBe(6);

    // Acotado AL BLOQUE del arqueo: sobre el innerHTML de la página entera, "$1,000" aparece
    // en la tira de KPIs y la prueba fallaba por un importe que no tiene nada que ver.
    const reja: string = fx.nativeElement.querySelector('.cg-arqueo').innerHTML;
    for (const b of ['$500', '$200', '$100', '$50', '$20']) expect(reja).toContain(b);
    expect(reja).toContain('Morralla');
    // El metal no se desglosa: si apareciera un renglón de 50¢ —o el billete de $1,000, que
    // esta caja no maneja— esto se pone rojo.
    expect(reja).not.toContain('50¢');
    expect(reja).not.toContain('$1,000');
  });

  it('[negativa] el MONTO no se puede teclear: sale del conteo y va deshabilitado', async () => {
    const fx = await capturaEnPantalla();
    const monto: HTMLInputElement | null = fx.nativeElement.querySelector('input#cg-monto');
    expect(monto).not.toBeNull();
    expect(monto!.disabled).toBe(true);
  });

  it('contar llena el monto y el importe del renglón, sin tocar el teclado del total', async () => {
    const fx = await capturaEnPantalla();
    contar({ 500: 2, 20: 3 });
    fx.detectChanges();

    expect(comp.subtotalDe(500)).toBe(1000);
    expect(comp.subtotalDe(20)).toBe(60);
    expect(comp.f().monto).toBe(1060);

    const monto: HTMLInputElement = fx.nativeElement.querySelector('input#cg-monto');
    expect(monto.value).toContain('1,060');
  });

  it('la morralla suma al monto sin desglosarse: "en morralla queda perfecto"', async () => {
    await capturaEnPantalla();
    contar({ 100: 1 });
    comp.setMorralla(7.5);
    expect(comp.f().monto).toBe(107.5);
  });

  it('las piezas son ENTERAS y no negativas: medio billete no existe', async () => {
    await capturaEnPantalla();
    comp.setPiezas(100, 3.7);
    expect(comp.piezasDe(100)).toBe(3);
    comp.setPiezas(100, -2);
    expect(comp.piezasDe(100)).toBe(0);
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
    ins[4].focus();
    ins[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(ins[5]);
    expect(ins[5].classList.contains('cg-morralla-in')).toBe(true);
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
    expect(comp.piezasDe(500)).toBe(0);
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
    expect(comp.piezasDe(500)).toBe(0);
    expect(comp.hayCajero()).toBe(true);
    expect(comp.aporteCajero()).toBe(1300);
    expect(comp.f().monto).toBe(1300);   // monto = aporte del cajero + reja (0)
  });

  it('CS.3.7 — el arqueo de la máquina va APARTE y la reja queda EDITABLE para la diferencia', async () => {
    const fx = await capturaEnPantalla();
    comp.elegirCaos({ value: CAOS_DEP } as any);
    fx.detectChanges();
    const piezas = inputsPieza(fx);
    const billetes = piezas.filter((i) => !i.classList.contains('cg-morralla-in'));
    const morralla = piezas.find((i) => i.classList.contains('cg-morralla-in'))!;
    expect(billetes.length).toBe(5);
    expect(billetes.every((i) => !i.readOnly)).toBe(true);  // editables: la reja es la DIFERENCIA
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
    expect(comp.piezasDe(500)).toBe(0);
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
    comp.setPiezas(500, 1); comp.setPiezas(200, 1); // 700 en efectivo
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
    const fx = montar({
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
    const fx = montar();
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
    const fx = montar();
    const panel = panelCierre(fx);
    expect(panel).toContain('Movimiento del dia');
    expect(panel.toLowerCase()).not.toContain('saldo del cajero');
  });

  it('⛔ [negativa] sin cajero en la sucursal NO pinta ceros: pinta el motivo', () => {
    const fx = montar({
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
    const fx = montar();
    const panel = panelCierre(fx);
    expect(panel).toContain('no publica cu');   // "...no publica cuánto efectivo tiene adentro"
    expect(fx.nativeElement.querySelector('.cg-conc-nm')).toBeTruthy();
  });

  it('un tipo de cajero DESCONOCIDO se pinta aparte y con aviso', () => {
    const fx = montar({
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
    const fx = montar({ arqueoDia: vi.fn(() => throwError(() => ({ status: 500, error: {} }))) });
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
});
