import { RouteDayService } from '../route-day.service';
/**
 * `[MCP.18]` Justificantes del lado de la vendedora, montados de verdad con el servidor simulado:
 *  · la hoja del motivo (elegir, «Otro» pide nota);
 *  · «Corregir» primero pregunta si se puede (D1) y sólo entonces pide el motivo;
 *  · cancelar un pedido que ya estaba agendado pide el motivo (un borrador suelto, no);
 *  · «Mis pedidos» dice por qué cambió su pedido y no afirma «no hubo» si el motivo fue otro.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, of, throwError } from 'rxjs';
import { MOTIVOS_CORREGIR, type PresaleSellerOrder, type PresaleSellerStatusResponse } from '@megadulces/contracts';
import { VendorService } from '../vendor.service';
import { VendorMotivoSheetComponent } from '../components/vendor-motivo-sheet.component';
import { VendorPendingComponent } from './vendor-pending.component';
import { VendorTakeOrderComponent } from './vendor-take-order.component';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { PresaleStatusService } from '../presale-status.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';

const txt = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const radio = (root: HTMLElement, t: string): HTMLInputElement =>
  (Array.from(root.querySelectorAll('.mo-opt')).find((o) => (o.textContent ?? '').includes(t)) as HTMLElement).querySelector('input') as HTMLInputElement;

describe('[MCP.18] la hoja del motivo', () => {
  let fix: ComponentFixture<VendorMotivoSheetComponent>;
  let emitido: unknown[];
  beforeEach(async () => {
    emitido = [];
    await TestBed.configureTestingModule({ imports: [VendorMotivoSheetComponent] }).compileComponents();
    fix = TestBed.createComponent(VendorMotivoSheetComponent);
    fix.componentRef.setInput('opciones', MOTIVOS_CORREGIR);
    fix.componentRef.setInput('confirmarTexto', 'Corregir el pedido');
    fix.componentInstance.confirm.subscribe((m) => emitido.push(m));
    fix.detectChanges();
  });
  afterEach(() => TestBed.resetTestingModule());
  const ok = (): HTMLButtonElement => (fix.nativeElement as HTMLElement).querySelector('.mo-ok') as HTMLButtonElement;

  it('negativa: sin elegir motivo no deja continuar', () => {
    expect(ok().disabled).toBe(true);
    ok().click();
    expect(emitido).toEqual([]);
  });

  it('con un motivo (y nota opcional) manda la clave del catálogo', () => {
    radio(fix.nativeElement, 'El cliente quiere agregar productos').dispatchEvent(new Event('change'));
    fix.detectChanges();
    expect(ok().disabled).toBe(false);
    ok().click();
    expect(emitido).toEqual([{ reason_code: 'agregar' }]);
  });

  it('negativa: «Otro motivo» sin escribir no deja continuar; escrito, sí', () => {
    radio(fix.nativeElement, 'Otro motivo').dispatchEvent(new Event('change'));
    fix.detectChanges();
    expect(ok().disabled).toBe(true);
    fix.componentInstance.nota.set('  el cliente cambió de sucursal ');
    fix.detectChanges();
    expect(ok().disabled).toBe(false);
    ok().click();
    expect(emitido).toEqual([{ reason_code: 'otro', note: 'el cliente cambió de sucursal' }]);
  });
});

describe('[MCP.18] «Corregir» en Por entregar', () => {
  afterEach(() => TestBed.resetTestingModule());
  const ORDEN = { id: 'o1', code: 'PD-1', folio: 'PD-2026-00072', customer_id: 'c1', customer_name: 'Abarrotes Prueba', status: 'confirmed', total: 100, created_at: '2026-11-10T15:00:00.000Z', is_preventa: true };

  async function montar(puede: () => Observable<unknown>) {
    const api = {
      pendingDeliveries: vi.fn(() => of([ORDEN])),
      puedeCorregir: vi.fn(puede),
      reopenOrder: vi.fn(() => of({ ...ORDEN, status: 'draft' })),
      orderById: vi.fn(() => of({ lines: [] })),
    };
    const toast = { add: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [VendorPendingComponent],
      providers: [provideRouter([]), { provide: VendorService, useValue: api }, { provide: MessageService, useValue: toast }],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorPendingComponent);
    fix.detectChanges();
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const el = fix.nativeElement as HTMLElement;
    const corregir = () => {
      (Array.from(el.querySelectorAll('button')).find((b) => txt(b).includes('Corregir')) as HTMLButtonElement).click();
      fix.detectChanges();
    };
    return { fix, el, api, toast, nav, corregir };
  }

  it('si se puede, pide el motivo y reabre CON él; después lleva a corregir', async () => {
    const t = await montar(() => of(ORDEN));
    t.corregir();
    expect(t.api.puedeCorregir).toHaveBeenCalledWith('o1');
    expect(t.api.reopenOrder).not.toHaveBeenCalled();
    expect(txt(t.el.querySelector('.mo-title'))).toBe('¿Por qué lo corriges?');
    radio(t.el, 'Cambiar la fecha de entrega').dispatchEvent(new Event('change'));
    t.fix.detectChanges();
    (t.el.querySelector('.mo-ok') as HTMLButtonElement).click();
    expect(t.api.reopenOrder).toHaveBeenCalledWith('o1', { reason_code: 'fecha' });
    expect(t.nav).toHaveBeenCalledWith(['/vendor/take-order', 'c1'], { queryParams: { order: 'o1' } });
  });

  it('negativa (D1): con el surtido empezado no pide motivo, no reabre y dice qué hacer', async () => {
    const msg = 'Ya lo está surtiendo Surtidor Prueba desde las 10:42: ya no se corrige desde la app. Si el cliente quiere algo más, toma un pedido nuevo.';
    const t = await montar(() => throwError(() => ({ status: 409, error: { message: msg } })));
    t.corregir();
    expect(t.el.querySelector('.mo-title')).toBeNull();
    expect(t.api.reopenOrder).not.toHaveBeenCalled();
    expect(t.toast.add).toHaveBeenCalledWith(expect.objectContaining({ summary: 'No se puede corregir', detail: msg }));
    expect(t.nav).not.toHaveBeenCalled();
  });
});

describe('[MCP.18] cancelar en Tomar pedido', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function montar(corrigiendo: boolean) {
    const llamadas: Record<string, unknown[][]> = {};
    const respuestas: Record<string, unknown> = {
      myStockSources: { sucursal: { id: 'w2', code: '02', name: 'Sucursal Prueba' }, camioneta: null },
      getCustomer: { id: 'c1', code: 'CLI-1', name: 'Abarrotes Prueba', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
      catalogInstant: { priceListId: 'pl1', prices: [], origen: 'servidor', at: Date.now() },
      catalogForCustomer: { priceListId: 'pl1', prices: [] },
      draftForCustomer: corrigiendo ? null : { id: 'o1', code: 'PD-1', lines: [] },
      pendingForCustomer: [],
      frequentProducts: [],
      priceCoverage: { unpriced: 0 },
      orderById: { id: 'o1', code: 'PD-2026-00072', status: 'draft', requested_delivery_date: '2030-01-02', lines: [] },
      myZoneStock: null,
      cancelarConMotivo: { id: 'o1', status: 'cancelled' },
      cancel: { id: 'o1', status: 'cancelled' },
    };
    const api = new Proxy({}, {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return (...a: unknown[]) => { (llamadas[prop] ??= []).push(a); return of(prop in respuestas ? respuestas[prop] : null); };
      },
    }) as unknown as VendorService;
    TestBed.configureTestingModule({
      imports: [VendorTakeOrderComponent],
      providers: [
        provideRouter([]),
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: VendorService, useValue: api },
        { provide: ConnectivityService, useValue: { isOnline: () => true } },
        { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve(), cacheCustomer: () => Promise.resolve() } },
        { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap(corrigiendo ? { order: 'o1' } : {}) } } },
      ],
    });
    const fix = TestBed.createComponent(VendorTakeOrderComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    return { fix, cmp: fix.componentInstance, el: fix.nativeElement as HTMLElement, llamadas, nav };
  }

  it('corrigiendo un pedido agendado: pide el motivo y cancela con él', async () => {
    const t = await montar(true);
    expect(t.cmp.isEditing()).toBe(true);
    t.cmp.cartOrderId.set('o1');
    t.cmp.cancelDraft();
    t.fix.detectChanges();
    expect(txt(t.el.querySelector('.mo-title'))).toBe('¿Por qué lo cancelas?');
    radio(t.el, 'Pedido duplicado').dispatchEvent(new Event('change'));
    t.fix.detectChanges();
    (t.el.querySelector('.mo-ok') as HTMLButtonElement).click();
    expect(t.llamadas['cancelarConMotivo']).toEqual([['o1', { reason_code: 'duplicado' }]]);
    expect(t.llamadas['cancel']).toBeUndefined();
    expect(t.nav).toHaveBeenCalledWith(['/vendor/pending']);
  });

  it('negativa: un borrador suelto se descarta como siempre, sin pedir motivo', async () => {
    const t = await montar(false);
    expect(t.cmp.isEditing()).toBe(false);
    t.cmp.cartOrderId.set('o1');
    t.cmp.cancelDraft();
    t.fix.detectChanges();
    expect(t.el.querySelector('.mo-title')).toBeNull();
    expect(t.cmp.cancelandoAgendado()).toBe(false);
    expect(t.llamadas['cancelarConMotivo']).toBeUndefined();
  });
});

describe('[MCP.18] Mis pedidos: por qué cambió', () => {
  afterEach(() => TestBed.resetTestingModule());
  const pedido = (p: Partial<PresaleSellerOrder> = {}): PresaleSellerOrder => ({
    order_id: 'o1', code: 'PD-2026-00072', customer_name: 'ABARROTES PRUEBA', requested_delivery_date: '2026-11-10',
    total: 100, lines: 2, status: 'confirmed', scheduled_at: '2026-11-10T15:00:00.000Z', warehouse_name: 'Sucursal Prueba',
    started: { user_id: 's1', name: 'Surtidor Prueba', at: '2026-11-10T16:00:00.000Z' },
    finished: { user_id: 's1', name: 'Surtidor Prueba', at: '2026-11-10T16:10:00.000Z', outcome: 'con_faltantes' },
    report: { removed: [{ product_name: 'SALSA', unit: 'CJA', ordered: 1, picked: 0, line_id: 'l9', reason: 'danado', reason_note: 'mojada' }], adjusted: [], total_before: 200, total_after: 100 },
    charge: null, delivered_at: null, report_unseen: true, ...p,
  });

  async function montar(p: PresaleSellerOrder) {
    const resp: PresaleSellerStatusResponse = { today: '2026-11-10', data: [p], unseen_reports: 1 };
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    await TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [
        { provide: PresaleStatusService, useValue: { status: vi.fn(() => of(resp)), markSeen: vi.fn(() => of({ updated: 1 })), unseen: vi.fn(() => of({ unseen_reports: 0 })) } },
        { provide: VendorService, useValue: { orderById: vi.fn(() => of({ id: 'o1', lines: [] })) } },
        // [MCP.19] El recuento del día y la cola del celular (se miden en vendor-recuento-dia.spec.ts).
        { provide: RecuentoDiaService, useValue: { dia: vi.fn(() => throwError(() => ({ error: { message: 'sin servidor en la prueba' } }))) } },
        { provide: OfflineOrderService, useValue: { pendingSummaries: vi.fn(() => Promise.resolve([])) } },
        // [MCP.21] Corregir/cancelar avisan con el toast; «Terminar mi día» lee la ruta del día.
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: RouteDayService, useValue: { today: vi.fn(() => of({ state: 'sin_iniciar' })) } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorMisPedidosComponent);
    fix.detectChanges();
    return { fix, texto: () => txt(fix.nativeElement as HTMLElement) };
  }

  it('dice quién, qué y el motivo; y el «(no hubo)» ya no se afirma si el motivo fue otro', async () => {
    const t = await montar(pedido({ justifications: [
      { actor: 'seller', action: 'reopened', by_name: 'Vendedora Prueba', at: '2026-11-10T15:30:00.000Z', product_name: null, detail: null, reason: null },
      { actor: 'picker', action: 'removed', by_name: 'Surtidor Prueba', at: '2026-11-10T16:10:00.000Z', product_name: 'SALSA', detail: '1 CJA', reason: 'Dañado o caducado: mojada' },
    ] }));
    expect(t.texto()).toContain('Por qué cambió');
    expect(t.texto()).toContain('Corrigió el pedido. Motivo: Sin motivo registrado');
    expect(t.texto()).toContain('Quitó SALSA (1 CJA). Motivo: Dañado o caducado: mojada');
    expect(t.texto()).toContain('Se quitó del pedido:');
    expect(t.texto()).toContain('SALSA · 1 CJA · Dañado o caducado: mojada');
    expect(t.texto()).not.toContain('(no hubo)');
  });

  it('negativa: un reporte de antes (sin motivo) se sigue leyendo igual, y sin cambios no hay recuadro', async () => {
    const t = await montar(pedido({ report: { removed: [{ product_name: 'SALSA', unit: 'CJA', ordered: 1, picked: 0 }], adjusted: [], total_before: 200, total_after: 100 }, justifications: [] }));
    expect(t.texto()).toContain('Se quitó del pedido (no hubo):');
    expect(t.texto()).not.toContain('Por qué cambió');
  });
});
