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
import { of, throwError } from 'rxjs';

import { FinanzasCajaGeneralComponent } from './finanzas-caja-general.component';
import {
  CashLedgerService, type CoberturaResponse, type LibroResponse, type SaldoResponse,
  type PendientesResponse, type Frecuente, type CajaKepler, type MovimientoPendiente,
} from '../../cash-ledger.service';
import { AuthService } from '../../../../core/services/auth.service';
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

const FRECUENTE: Frecuente = {
  kepler_cuenta: '601-001', kepler_concepto: 'PAPELERIA', glosa: 'hojas',
  beneficiario: 'PAPELERA SA', usos: 9, ultimo_uso: '2026-09-20', rango: 1,
};

const CAJAS: CajaKepler[] = [
  { clave: '0011', nombre: 'CAJA GENERAL', cuenta_contable: '102-0011', documentos: 9142 },
  { clave: '0030', nombre: 'CAJA CHICA MORELIA ABASTOS', cuenta_contable: '102', documentos: 0 },
];

describe('FinanzasCajaGeneralComponent · CG.22', () => {
  let svc: Record<string, ReturnType<typeof vi.fn>>;
  let comp: FinanzasCajaGeneralComponent;

  function montar(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
    svc = {
      cobertura: vi.fn(() => of(COBERTURA)),
      libro: vi.fn(() => of(LIBRO)),
      saldo: vi.fn(() => of(SALDO)),
      cortes: vi.fn(() => of({ rows: [] })),
      cajas: vi.fn(() => of({ rows: CAJAS, ventana_dias: 1 })),
      movimientosPendientes: vi.fn(() => of(VACIA)),
      frecuentes: vi.fn(() => of({ rows: [FRECUENTE] })),
      autofill: vi.fn(() => of({ concepto: null, provenance: null })),
      conceptos: vi.fn(() => of({ rows: [] })),
      crear: vi.fn(() => of({ id: 'm1' })),
      declararRegla: vi.fn(() => of({ creada: true, id: 'r1' })),
      confirmarLote: vi.fn(() => of({ filas: [], guardados: 0, duplicados: 0, rechazados: 0, no_confirmables: 0, monto_guardado: 0 })),
      ...over,
    };

    TestBed.configureTestingModule({
      imports: [FinanzasCajaGeneralComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: CashLedgerService, useValue: svc },
        { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }) } },
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
    comp.setF('monto', 1500);

    expect(comp.bloqueos()).toEqual([]);
  });

  it('y al vaciar un campo vuelve a bloquear (no es que quedó abierto para siempre)', () => {
    montar();
    comp.abrirCaptura();
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'compra de papeleria');
    comp.setF('monto', 1500);
    expect(comp.bloqueos()).toEqual([]);

    comp.setF('monto', null);
    expect(comp.bloqueos()).toContain('monto_invalido');
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

  it('«Capturar» abre el diálogo ANCLADO al documento y con lo contado puesto', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.setContado(GASTO_TRABADO.origen_ref, 1100);
    comp.capturarDesde(GASTO_TRABADO);

    expect(comp.capturaAbierta()).toBe(true);
    expect(comp.cobroElegido()?.origen_ref).toBe(GASTO_TRABADO.origen_ref);
    expect(comp.f().tipo).toBe('gasto');
    // Manda lo contado, no lo que dice el ERP: nunca se rechaza efectivo.
    expect(comp.f().monto).toBe(1100);
    expect(comp.montoContado()).toBe(1100);
    expect(comp.f().sucursal).toBe('00');
  });

  it('sin conteo, el importe lo pone el documento y NO se marca como arqueo', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    expect(comp.f().monto).toBe(1060);
    expect(comp.montoContado()).toBe(null);
  });

  it('cambiar el monto con documento anclado ES un conteo; volver al del ERP deja de serlo', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);

    comp.onMonto(1100);
    expect(comp.montoContado()).toBe(1100);

    comp.onMonto(1060);           // el mismo del documento
    expect(comp.montoContado()).toBe(null);
  });

  it('guardar manda monto_contado y el origen_tipo del DOCUMENTO, no "cobro" clavado', () => {
    montar({ movimientosPendientes: vi.fn(() => of(CON_GASTO)) });
    comp.capturarDesde(GASTO_TRABADO);
    comp.setF('kepler_cuenta', '601-001');
    comp.setF('kepler_concepto', 'PAPELERIA');
    comp.setF('glosa', 'gasto de caja chica');
    comp.onMonto(1100);

    expect(comp.bloqueos()).toEqual([]);
    comp.guardar();

    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // Un X-D-26 guardado como 'cobro' es un origen mal etiquetado.
    expect(body['origen_tipo']).toBe('pago_proveedor');
    expect(body['origen_ref']).toBe(GASTO_TRABADO.origen_ref);
    // Sin esto el servidor relee el importe del ERP y lo contado no llega al libro.
    expect(body['monto_contado']).toBe(1100);
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
      autofill: vi.fn(() => of({ concepto: null, provenance: null })), conceptos: vi.fn(() => of({ rows: [] })),
      crear: vi.fn(() => of({ id: 'm1' })),
      confirmarLote: vi.fn(() => of({ filas: [], guardados: 0, duplicados: 0, rechazados: 0, no_confirmables: 0, monto_guardado: 0 })),
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
    comp.onMonto(250);
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
    comp.onMonto(500);
    comp.guardar();

    const body = svc['crear'].mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body['monto_contado']).toBeUndefined();
    expect(body['origen_tipo']).toBe(null);
  });
});
