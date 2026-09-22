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
