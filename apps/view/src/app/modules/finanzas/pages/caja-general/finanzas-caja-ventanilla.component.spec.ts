import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { EstadoDeCobro, PlanDePagoVentanilla, ResultadoCobro, SaldosDelLibro, VeredictoDePago } from '@megadulces/contracts';
import { FinanzasCajaVentanillaComponent } from './finanzas-caja-ventanilla.component';
import { CashLedgerService, type MovimientoPendiente, type PendientesResponse } from '../../cash-ledger.service';
import { LibroEfectivoService } from '../../libro-efectivo.service';
import { AuthService } from '../../../../core/services/auth.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { CONTEXT_HELP } from '../../../../shared/context-help/context-help.dictionary';

/**
 * `[LE.2.13]` La Ventanilla montada con sus dos fuentes sustituidas (la cola de Kepler y el libro),
 * USADA como la usaría la cajera: la cola en el orden de la tarea, lo detenido con su porqué, y un
 * pago de punta a punta (plan → monedas → quien recibe → pagar → código).
 */
class ResizeObserverStub { observe(): void { /* no-op */ } unobserve(): void { /* no-op */ } disconnect(): void { /* no-op */ } }
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

const doc = (folio: string, monto: number, over: Partial<MovimientoPendiente> = {}): MovimientoPendiente => ({
  origen_ref: `00|X-D-26|${folio}|0011`, tipo: 'gasto', origen_tipo: 'pago_proveedor', clave_banco: '0011', caja_nombre: 'CAJA GENERAL',
  sucursal: '00', doc_tipo: 'X-D-26', folio, fecha_valor: '2026-11-03', entidad_code: null, beneficiario: 'PROVEEDOR ' + folio,
  concepto: null, metodo: null, monto, confirmable: true, kepler_cuenta: '201', kepler_concepto: '001', ...over,
});
const COLA: PendientesResponse = {
  rows: [doc('0000001', 600), doc('0000002', 17230), doc('0000003', 250)],
  limit: 200, has_more: false, confirmables: 3, datos_al: '2026-11-03T18:00:00Z', mal_fechados: { movimientos: 2, monto: 500 },
};
const VEREDICTOS: VeredictoDePago[] = [
  { origen_ref: '00|X-D-26|0000001|0011', respaldo: 'gasto', puede: false, requiere_firma: false, bloqueo: 'gasto_sin_aprobar',
    motivo: 'El gasto todavía no lo aprueba nadie en Aprobación de gastos: se aprueba ahí antes de pagar.', arreglo: 'aprobacion_gastos',
    detalle: [{ tipo: 'gasto', folio: '0000220', aplicado_minor: '60000', vale_folio: '0000247', aprobado: false }] },
  { origen_ref: '00|X-D-26|0000002|0011', respaldo: 'compra', puede: true, requiere_firma: false, bloqueo: null, motivo: null, arreglo: null,
    detalle: [{ tipo: 'entrada', folio: '0000367', aplicado_minor: '1723000', vale_folio: null, aprobado: null }] },
  { origen_ref: '00|X-D-26|0000003|0011', respaldo: 'ninguno', puede: true, requiere_firma: true, bloqueo: null,
    motivo: 'Kepler no dice qué gasto o compra paga', arreglo: null, detalle: [] },
];
const PLAN: PlanDePagoVentanilla = {
  origen_ref: '00|X-D-26|0000002|0011', folio: '0000002', beneficiario: 'PROVEEDOR 0000002', importe_minor: '1723000',
  pagable_minor: '1723000', redondeo_minor: '0', maquina_minor: '1722000', cajon_minor: '1000', requiere_firma: false,
  motivo_firma: null, bloqueo: null, motivo_bloqueo: null,
};

// `[LE.6.7]` La cola de cobros: uno de ruta, uno de sucursal, uno detenido y uno ya recibido en el libro nuevo.
const cobroDoc = (almacen: string, folio: string, monto: number): MovimientoPendiente =>
  doc(folio, monto, { origen_ref: `${almacen}|U-A-5|${folio}|0011`, tipo: 'ingreso', origen_tipo: 'cobro', sucursal: almacen,
    doc_tipo: 'U-A-5', beneficiario: 'CONTADO', kepler_cuenta: null, kepler_concepto: null });
const COBROS: PendientesResponse = {
  rows: [cobroDoc('01-004', '0000028', 900), cobroDoc('01-002', '0000029', 1850), cobroDoc('07', '0000169', 318.24), cobroDoc('01-003', '0000027', 500)],
  limit: 200, has_more: false, confirmables: 4, datos_al: '2026-11-03T18:00:00Z',
};
const ESTADOS: EstadoDeCobro[] = [
  { origen_ref: '01-004|U-A-5|0000028|0011', tipo: 'detenido', ruta: null, esperado_minor: '90000', recibido: false,
    motivo: 'El cobro junta varias rutas: no se sabe cuánto rinde cada una. Se recibe por ruta.' },
  { origen_ref: '01-002|U-A-5|0000029|0011', tipo: 'ruta', ruta: '22', esperado_minor: '185000', recibido: false, motivo: null },
  { origen_ref: '07|U-A-5|0000169|0011', tipo: 'sucursal', ruta: null, esperado_minor: '31824', recibido: false, motivo: null },
  { origen_ref: '01-003|U-A-5|0000027|0011', tipo: 'ruta', ruta: '23', esperado_minor: '50000', recibido: true, motivo: null },
];

function montar(opciones: { jornada?: string | null; saldosFalla?: boolean; gestionar?: boolean } = {}) {
  const ledger = { movimientosPendientes: vi.fn((f: { doc_tipo?: string }) => of(f.doc_tipo === 'U-A-5' ? COBROS : COLA)) };
  const libro = {
    saldos: vi.fn(() => (opciones.saldosFalla ? throwError(() => ({ status: 403 }))
      : of({ cuentas: [], ultimo_asiento: '0', jornada_abierta: opciones.jornada === undefined ? '2026-11-03' : opciones.jornada,
        integridad: { integra: true, problemas: [] } } as SaldosDelLibro))),
    veredictos: vi.fn(() => of(VEREDICTOS)),
    plan: vi.fn(() => of(PLAN)),
    pagar: vi.fn(() => of({ estado: 'pagado' as const, orden_id: 'o1', codigo: 'JAQD-8', maquina_minor: '1722000', cajon_minor: '1000',
      redondeo_minor: '0', entry_id: 'e1', vence: '2026-11-04T06:00:00Z' })),
    estadoDeCobros: vi.fn(() => of(ESTADOS)),
    recibir: vi.fn(() => of<ResultadoCobro>({ estado: 'recibido', entry_id: 'e2', tipo: 'ruta', ruta: '22', contado_minor: '180000',
      esperado_minor: '185000', diferencia_minor: '-5000', es_redondeo: false })),
  };
  TestBed.configureTestingModule({
    imports: [FinanzasCajaVentanillaComponent],
    providers: [
      provideZonelessChangeDetection(), provideRouter([]),
      { provide: CashLedgerService, useValue: ledger },
      { provide: LibroEfectivoService, useValue: libro },
      { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }), token: () => null } },
      { provide: PermissionsService, useValue: { has: () => opciones.gestionar !== false, hasAny: () => true, isAdmin: () => false } },
    ],
  });
  const fixture = TestBed.createComponent(FinanzasCajaVentanillaComponent);
  fixture.detectChanges();
  return { fixture, comp: fixture.componentInstance, ledger, libro, el: fixture.nativeElement as HTMLElement };
}

describe('[LE.2.13] la Ventanilla', () => {
  it('pide la cola de Caja General (X-D-26 de la 0011) y los veredictos de esos documentos en UN viaje', () => {
    const { ledger, libro } = montar();
    expect(ledger.movimientosPendientes).toHaveBeenCalledWith({ doc_tipo: 'X-D-26', tipo: 'gasto', caja: '0011', sucursal: '00', limit: 200 });
    expect(libro.veredictos).toHaveBeenCalledTimes(1);
    expect(libro.veredictos).toHaveBeenCalledWith(COLA.rows.map((r) => r.origen_ref));
  });

  it('la cola va en el orden de la tarea y lo detenido dice por qué y dónde se arregla', () => {
    const { el } = montar();
    const filas = [...el.querySelectorAll('tr[data-estado]')];
    expect(filas.map((f) => f.getAttribute('data-estado'))).toEqual(['pagable', 'firma', 'detenido']);
    const detenido = filas[2];
    expect(detenido.textContent).toContain('gasto sin aprobar');
    expect(detenido.textContent).toContain('se aprueba ahí antes de pagar');
    expect(detenido.querySelector('a')?.getAttribute('href')).toBe('/finanzas/aprobacion-gastos');
    expect((detenido.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(filas[1].textContent).toContain('Pedir firma');
    expect(el.textContent).toContain('2 documentos vienen fechados');
  });

  it('pagar de punta a punta: plan → monedas del cajón → quien recibe → código', () => {
    const { fixture, comp, libro, el } = montar();
    comp.abrir(comp.filas()[0]);
    fixture.detectChanges();
    expect(libro.plan).toHaveBeenCalledWith('00|X-D-26|0000002|0011', '201');
    expect(document.body.textContent).toContain('Paga la compra: entrada 0000367');
    // NEGATIVA: sin las monedas exactas y sin quien recibe, no se paga.
    expect(comp.listoParaPagar()).toBe(false);
    comp.recibe.set('Encargado del proveedor');
    comp.piezas.set({ 5: 1 });
    expect(comp.listoParaPagar()).toBe(false);          // $5 de $10
    comp.piezas.set({ 10: 1 });
    expect(comp.listoParaPagar()).toBe(true);
    comp.pagar();
    fixture.detectChanges();
    expect(libro.pagar).toHaveBeenCalledTimes(1);
    const [body, llave] = libro.pagar.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(body).toEqual({ origen_ref: '00|X-D-26|0000002|0011', cuenta_kepler: '201', piezas_cajon: { 10: '1' },
      recibe: { nombre: 'Encargado del proveedor' } });
    expect(llave).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.body.querySelector('[data-testid="codigo"]')?.textContent).toContain('JAQD-8');
    void el;
  });

  it('NEGATIVA: un reintento del mismo pago usa la MISMA llave (no paga dos veces)', () => {
    const { comp, libro } = montar();
    libro.pagar.mockReturnValueOnce(throwError(() => ({ error: { codigo: 'x', mensaje: 'se cayó la red' } })));
    comp.abrir(comp.filas()[0]);
    comp.recibe.set('Encargado');
    comp.piezas.set({ 10: 1 });
    comp.pagar();
    expect(comp.errorPago()).toBe('se cayó la red');
    comp.pagar();
    const llaves = libro.pagar.mock.calls.map((c) => (c as unknown as [unknown, string])[1]);
    expect(llaves).toHaveLength(2);
    expect(llaves[0]).toBe(llaves[1]);
  });

  it('NEGATIVA: lo detenido no abre el pago, ni con el teclado', () => {
    const { comp, libro } = montar();
    comp.abrirFila(comp.filas()[2]);
    comp.abrir(comp.filas()[2]);
    expect(libro.plan).not.toHaveBeenCalled();
    expect(comp.pagando()).toBeNull();
  });

  it('sin el día del libro abierto: se ve la cola y lo dice, pero no se paga', () => {
    const { el, comp } = montar({ jornada: null });
    expect(el.querySelector('[data-testid="libro-sin-dia"]')?.textContent).toContain('Falta el saldo de arranque');
    expect(comp.puedePagar()).toBe(false);
    expect([...el.querySelectorAll('tr[data-estado] button')].every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('si no se pudo leer el libro, lo declara (no lo da por abierto ni por cerrado)', () => {
    const { el } = montar({ saldosFalla: true });
    expect(el.querySelector('[data-testid="libro-sin-medir"]')).not.toBeNull();
  });

  it('sin el permiso de operar la caja, se ve pero no se paga', () => {
    const { comp } = montar({ gestionar: false });
    expect(comp.puedePagar()).toBe(false);
  });

  it('su ayuda existe en el diccionario', () => {
    expect(CONTEXT_HELP['caja-ventanilla']?.title).toContain('Ventanilla');
  });

  // ── `[LE.6.7]` Por recibir ───────────────────────────────────────────────────────────────

  it('[LE.6.7] pide los cobros U-A-5 de la 0011 y su estado en UN viaje; lo ya recibido no se lista, se cuenta', () => {
    const { ledger, libro, el, comp } = montar();
    expect(ledger.movimientosPendientes).toHaveBeenCalledWith({ doc_tipo: 'U-A-5', tipo: 'ingreso', caja: '0011', limit: 200 });
    expect(libro.estadoDeCobros).toHaveBeenCalledTimes(1);
    expect(libro.estadoDeCobros).toHaveBeenCalledWith(COBROS.rows.map((r) => r.origen_ref));
    const filas = [...el.querySelectorAll('tr[data-cobro]')];
    expect(filas.map((f) => f.getAttribute('data-cobro'))).toEqual(['recibible', 'recibible', 'detenido']);
    expect(filas[0].textContent).toContain('ruta 22');
    expect(filas[2].textContent).toContain('varias rutas');
    expect((filas[2].querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(el.textContent).toContain('1 ya está recibido en el libro nuevo');
    // Lo que se espera recibir hoy: sólo lo recibible (1,850 + 318.24), no lo detenido.
    expect(comp.kpis().find((k) => k.label === 'Por recibir')?.value).toBe(2168.24);
  });

  it('[LE.6.7] recibir: primero cómo llegó el dinero; lo de la máquina NO se cuenta aquí', () => {
    const { fixture, comp, libro } = montar();
    comp.abrirCobro(comp.cobros()[0]);
    fixture.detectChanges();
    expect(document.body.textContent).toContain('¿Cómo llegó este dinero?');
    // NEGATIVA: sin decir que llegó al cajón, aunque haya piezas y nombre, no se recibe.
    comp.piezasCobro.set({ 500: 3 });
    comp.entrega.set('Chofer');
    expect(comp.listoParaRecibir()).toBe(false);
    comp.modoCobro.set('maquina');
    fixture.detectChanges();
    expect(document.body.querySelector('[data-testid="cobro-maquina"]')?.textContent).toContain('lo registra la máquina');
    expect(comp.listoParaRecibir()).toBe(false);
    comp.recibir();
    expect(libro.recibir).not.toHaveBeenCalled();
  });

  it('[LE.6.7] recibir en el cajón de punta a punta: piezas → quién entrega → recibir → la diferencia en palabras', () => {
    const { fixture, comp, libro } = montar();
    comp.abrirCobro(comp.cobros()[0]);
    comp.modoCobro.set('cajon');
    fixture.detectChanges();
    expect(comp.listoParaRecibir()).toBe(false);            // sin piezas
    comp.piezasCobro.set({ 500: 3, 200: 1, 100: 1 });
    fixture.detectChanges();
    expect(document.body.querySelector('[data-testid="diferencia-cobro"]')?.textContent).toContain('Faltan $50.00: la ruta 22 los sigue debiendo');
    expect(comp.listoParaRecibir()).toBe(false);            // sin quién entrega
    comp.entrega.set('Chofer de la ruta');
    expect(comp.listoParaRecibir()).toBe(true);
    comp.recibir();
    fixture.detectChanges();
    const [body, llave] = libro.recibir.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(body).toEqual({ origen_ref: '01-002|U-A-5|0000029|0011', piezas: { 500: '3', 200: '1', 100: '1' }, entrega: { nombre: 'Chofer de la ruta' } });
    expect(llave).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.body.querySelector('[data-testid="resultado-cobro"]')?.textContent).toContain('la ruta 22 los sigue debiendo');
  });

  it('[LE.6.7] NEGATIVA: lo detenido no abre, y sin el día del libro no se recibe', () => {
    const { comp } = montar();
    const detenido = comp.cobros().find((f) => f.estado === 'detenido')!;
    comp.abrirCobro(detenido);
    expect(comp.recibiendo()).toBeNull();
    TestBed.resetTestingModule();
    const sinDia = montar({ jornada: null }).comp;
    sinDia.abrirCobro(sinDia.cobros()[0]);
    sinDia.modoCobro.set('cajon');
    sinDia.piezasCobro.set({ 500: 1 });
    sinDia.entrega.set('Chofer');
    expect(sinDia.listoParaRecibir()).toBe(false);
  });
});
