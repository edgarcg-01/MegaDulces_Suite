// `[MCP.3.15]` Tomar pedido: las indicaciones para el surtidor (un solo recuadro por pedido, escrito o
// dictado) y que viajen con el pedido. Monta la pantalla real con un doble de VendorService (mismo
// patrón que vendor-tomar-pedido-avisos.spec.ts).
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { Observable, of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, currency: 'MXN', sales_units_30d: 10 };
const sabritas = { ...base, id: 'a', product_id: 'a', product_name: 'Sabritas Original 45g', sku: '1', price: 29.5, stock_available: 50 };
const RENGLON = { id: 'l1', product_id: 'a', quantity: 2, line_subtotal: 59, line_tax: 0, line_total: 59, unit_price: 29.5 };

type Resp = unknown | ((...a: unknown[]) => Observable<unknown>);

function montar(extra: Record<string, Resp> = {}) {
  const llamadas: Record<string, unknown[][]> = {};
  const respuestas: Record<string, Resp> = {
    myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'C1', name: 'Modelorama Av. Juárez', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogInstant: { priceListId: 'pl1', prices: [sabritas], origen: 'servidor', at: Date.now() },
    catalogForCustomer: { priceListId: 'pl1', prices: [sabritas] },
    // Un borrador en curso, con su renglón y las indicaciones que ya traía.
    draftForCustomer: { id: 'o1', code: 'PD-1', notes: 'Bajar por la puerta de atrás', lines: [RENGLON] },
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
    orderById: { id: 'o1', lines: [RENGLON] },
    placeOrder: { id: 'o1', code: 'PD-1', total: 59 },
    ...extra,
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...a: unknown[]) => {
        (llamadas[prop] ??= []).push(a);
        const r = respuestas[prop];
        return typeof r === 'function' ? (r as (...x: unknown[]) => Observable<unknown>)(...a) : of(prop in respuestas ? r : null);
      };
    },
  }) as unknown as VendorService;
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      { provide: MessageService, useValue: { add: () => undefined } },
      { provide: VendorService, useValue: api },
      { provide: ConnectivityService, useValue: { isOnline: () => true } },
      { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve(), cacheCustomer: () => Promise.resolve() } },
      { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fixture = TestBed.createComponent(VendorTakeOrderComponent);
  fixture.detectChanges();
  const cmp = fixture.componentInstance;
  const el = fixture.nativeElement as HTMLElement;
  // La confirmación de «Agendar» se acepta sola (la de la pantalla, no una global).
  const confirm = fixture.debugElement.injector.get(ConfirmationService);
  vi.spyOn(confirm, 'confirm').mockImplementation((c) => { c.accept?.(); return confirm; });
  return { fixture, cmp, el, llamadas };
}

/** Un reconocedor de voz falso: al empezar «escucha» `frase` (o falla con `error`) y termina. */
function vozFalsa(frase: string, error?: string) {
  return class {
    lang = ''; interimResults = false; continuous = false;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error?: string }) => void) | null = null;
    start(): void {
      if (error) this.onerror?.({ error });
      else this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: frase }, isFinal: true }] });
      this.onend?.();
    }
    stop(): void { this.onend?.(); }
  };
}

const ventana = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };

describe('Tomar pedido · indicaciones para el surtidor [MCP.3.15]', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    delete ventana.SpeechRecognition;
    delete ventana.webkitSpeechRecognition;
  });

  it('el borrador en curso trae sus indicaciones al recuadro', () => {
    const { cmp } = montar();
    expect(cmp.indicaciones()).toBe('Bajar por la puerta de atrás');
  });

  it('⭐ «Agendar» de la barra abre «Tu pedido» (donde está el recuadro) y NO agenda sin verlo', () => {
    const { cmp, fixture, el, llamadas } = montar();
    fixture.detectChanges();
    const barra = el.querySelector<HTMLButtonElement>('.cartbar .cb-go');
    expect(barra).toBeTruthy();
    barra!.click();
    fixture.detectChanges();
    expect(cmp.cartOpen()).toBe(true);
    expect(el.querySelector('#to-ind')).toBeTruthy();
    expect(llamadas['placeOrder']).toBeUndefined();
  });

  it('⭐ las indicaciones viajan con el pedido, limpias de espacios', () => {
    const { cmp, llamadas } = montar();
    cmp.indicaciones.set('  Las Sabritas con caducidad de diciembre en adelante.  ');
    cmp.submit();
    const [, dto] = (llamadas['placeOrder'] ?? [])[0] as [string, { notes?: string; requested_delivery_date?: string }];
    expect(dto.notes).toBe('Las Sabritas con caducidad de diciembre en adelante.');
    expect(dto.requested_delivery_date).toBe(cmp.requestedDate);
  });

  it('prueba negativa: sin indicaciones se manda vacío (el servidor lo guarda como «sin indicaciones»)', () => {
    const { cmp, llamadas } = montar({ draftForCustomer: { id: 'o1', code: 'PD-1', notes: null, lines: [RENGLON] } });
    expect(cmp.indicaciones()).toBe('');
    cmp.submit();
    const [, dto] = (llamadas['placeOrder'] ?? [])[0] as [string, { notes?: string }];
    expect(dto.notes).toBe('');
  });

  it('si habla de sabores, avisa que cada sabor es otro producto en Kepler; si no, no', () => {
    const { cmp, fixture, el } = montar();
    cmp.cartOpen.set(true);
    cmp.indicaciones.set('Del Electrolit una de fresa y una de coco');
    fixture.detectChanges();
    expect(el.querySelector('.ind-warn')?.textContent).toContain('Eso cambia el producto');
    cmp.indicaciones.set('Las Sabritas con caducidad de diciembre');
    fixture.detectChanges();
    expect(el.querySelector('.ind-warn')).toBeNull();
  });

  it('dictar suma lo escuchado a lo ya escrito', () => {
    ventana.SpeechRecognition = vozFalsa('traer cambio de 500');
    const { cmp, fixture, el } = montar();
    cmp.cartOpen.set(true);
    fixture.detectChanges();
    const mic = el.querySelector<HTMLButtonElement>('.ind-mic');
    expect(mic?.textContent).toContain('Dictar');
    mic!.click();
    expect(cmp.indicaciones()).toBe('Bajar por la puerta de atrás. Traer cambio de 500');
    expect(cmp.escuchando()).toBe(false);
    expect(cmp.dictadoError()).toBeNull();
  });

  it('si el navegador no da el micrófono, lo dice y no borra lo escrito', () => {
    ventana.SpeechRecognition = vozFalsa('', 'not-allowed');
    const { cmp, fixture, el } = montar();
    cmp.cartOpen.set(true);
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.ind-mic')!.click();
    fixture.detectChanges();
    expect(cmp.dictadoError()).toContain('permiso');
    expect(el.querySelector('.ind-err')?.textContent).toContain('permiso');
    expect(cmp.indicaciones()).toBe('Bajar por la puerta de atrás');
  });

  it('prueba negativa: un navegador sin dictado no muestra el botón y pide escribirlas', () => {
    const { cmp, fixture, el } = montar();
    cmp.cartOpen.set(true);
    fixture.detectChanges();
    expect(el.querySelector('.ind-mic')).toBeNull();
    expect(el.textContent).toContain('Este navegador no puede dictar');
  });
});
