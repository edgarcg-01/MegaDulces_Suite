// `[MCP.26]` Tomar pedido: buscar el producto dictando, y el buscador por palabras (cada palabra, en
// cualquier orden, sin acentos). Monta la pantalla real con un doble de VendorService (mismo patrón que
// vendor-indicaciones.spec.ts).
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, currency: 'MXN', sales_units_30d: 10, stock_available: 50 };
/** Nombres con la forma real de Kepler: misma marca en dos tamaños, unidad pegada, eñe. */
const PRODUCTOS = [
  { ...base, id: 'a', product_id: 'a', product_name: 'LA ROSA BOMBON MEDIANO 400GR', sku: '20011', price: 61 },
  { ...base, id: 'b', product_id: 'b', product_name: 'LA ROSA BOMBON 1KG', sku: '20012', price: 140 },
  { ...base, id: 'c', product_id: 'c', product_name: 'COCA COLA 600 ML', sku: '30001', price: 18 },
  { ...base, id: 'd', product_id: 'd', product_name: 'PIÑA EN ALMIBAR 800G', sku: '40007', price: 45 },
];

type Resp = unknown | ((...a: unknown[]) => Observable<unknown>);

function montar() {
  const respuestas: Record<string, Resp> = {
    myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'C1', name: 'Modelorama Av. Juárez', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogInstant: { priceListId: 'pl1', prices: PRODUCTOS, origen: 'servidor', at: Date.now() },
    catalogForCustomer: { priceListId: 'pl1', prices: PRODUCTOS },
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...a: unknown[]) => {
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
  const nombres = () => cmp.displayed().map((p) => p.product_name);
  const micBuscador = () => el.querySelector<HTMLButtonElement>('.search app-dictar-busqueda button');
  return { fixture, cmp, el, nombres, micBuscador };
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

describe('[MCP.26] Tomar pedido · buscar dictando y por palabras', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    delete ventana.SpeechRecognition;
    delete ventana.webkitSpeechRecognition;
  });

  it('⭐ dictar «bombón de la rosa de un kilo» deja «bombón rosa 1 k» en el campo y encuentra el de 1 KG, no el de 400', async () => {
    ventana.SpeechRecognition = vozFalsa('Bombón de la Rosa de un kilo');
    const { fixture, cmp, el, nombres, micBuscador } = montar();
    expect(micBuscador()).toBeTruthy();
    micBuscador()!.click();
    fixture.detectChanges();
    // ngModel escribe el valor del campo en un paso asíncrono.
    await fixture.whenStable();
    fixture.detectChanges();
    expect(cmp.searchTerm()).toBe('bombón rosa 1 k');
    expect(el.querySelector<HTMLInputElement>('.search input')!.value).toBe('bombón rosa 1 k');
    expect(nombres()).toEqual(['LA ROSA BOMBON 1KG']);
  });

  it('prueba negativa: la frase tal cual, escrita, no encuentra nada (por eso se convierte)', () => {
    const { cmp, nombres } = montar();
    cmp.alBuscar('bombón de la rosa de un kilo');
    expect(nombres()).toEqual([]);
  });

  it('el micrófono del buscador no toca las indicaciones para el surtidor', () => {
    ventana.SpeechRecognition = vozFalsa('coca seiscientos mililitros');
    const { fixture, cmp, micBuscador, nombres } = montar();
    micBuscador()!.click();
    fixture.detectChanges();
    expect(cmp.indicaciones()).toBe('');
    expect(nombres()).toEqual(['COCA COLA 600 ML']);
  });

  it('por palabras: en cualquier orden, sin acentos y con la clave', () => {
    const { cmp, nombres } = montar();
    cmp.alBuscar('600 coca');
    expect(nombres()).toEqual(['COCA COLA 600 ML']);
    cmp.alBuscar('pina');
    expect(nombres()).toEqual(['PIÑA EN ALMIBAR 800G']);
    cmp.alBuscar('bombon 20011');
    expect(nombres()).toEqual(['LA ROSA BOMBON MEDIANO 400GR']);
  });

  it('⛔ sin permiso del micrófono se dice debajo del buscador, como alerta', () => {
    ventana.SpeechRecognition = vozFalsa('', 'not-allowed');
    const { fixture, el, micBuscador } = montar();
    micBuscador()!.click();
    fixture.detectChanges();
    const alerta = Array.from(el.querySelectorAll('[role="alert"]')).find((a) => a.querySelector('.pi-microphone'));
    expect(alerta?.textContent).toContain('no dio permiso para usar el micrófono');
  });

  it('sin reconocimiento de voz en el navegador, el buscador no muestra micrófono', () => {
    const { micBuscador, el } = montar();
    expect(el.querySelector('.search input')).toBeTruthy();
    expect(micBuscador()).toBeNull();
  });
});
