// Candado de "vendedor veloz": Tomar pedido y Mi ruta ya NO piden nada al motor de IA.
//
// Antes, abrir un cliente disparaba GET /intelligence/thot/suggest (y otra vez tras cada
// ráfaga de +/−), el micrófono mandaba el dictado a POST /ai-order/suggest, y Mi ruta
// esperaba GET /intelligence/nba DENTRO del forkJoin que pinta la lista (más un
// POST /intelligence/signals al abrir la hoja de un cliente "para reordenar").
//
// La prueba usa un doble de VendorService que ANOTA cada método que la pantalla llama y
// responde con datos fijos, así que mide exactamente qué sale a la red en cada apertura.
import { TestBed, fakeAsync, tick, flush } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { RouteDayService } from '../route-day.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { GeolocationService } from '../../../core/services/geolocation.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';
import { VendorRouteHomeComponent } from './vendor-route-home.component';

/** Métodos de VendorService que llegan al motor de inteligencia / IA. */
const METODOS_IA = ['thotSuggest', 'aiOrderSuggest', 'nbaDue', 'recordSignal', 'thotChat', 'thotFeedback'];

/** Doble de VendorService: cualquier método devuelve of(respuesta) y queda anotado. */
function dobleApi(respuestas: Record<string, unknown>): { api: VendorService; llamadas: string[] } {
  const llamadas: string[] = [];
  const api = new Proxy(
    {},
    {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return () => {
          llamadas.push(prop);
          return of(prop in respuestas ? respuestas[prop] : null);
        };
      },
    },
  ) as unknown as VendorService;
  return { api, llamadas };
}

const cliente = {
  id: 'c1',
  code: 'CLI-1',
  name: 'Abarrotes Lupita',
  credit_limit: 0,
  active: true,
  default_price_list_id: 'pl1',
};

const productoAltaRotacion = {
  id: 'pr1',
  product_id: 'p1',
  product_name: 'Paleta Payaso',
  sku: '1001',
  price: 120,
  tax_rate: 0.16,
  min_qty: 1,
  stock_available: 50,
  rotation_tier: 'alta' as const,
  sales_units_30d: 300,
};

describe('Tomar pedido sin IA', () => {
  // Simula un navegador CON dictado (Chrome Android): con el código viejo esto pintaba el
  // micrófono. jsdom no trae Web Speech API, así que sin esto la aserción sería vacía.
  const w = window as unknown as Record<string, unknown>;
  beforeEach(() => { w['webkitSpeechRecognition'] = class {}; });
  afterEach(() => { delete w['webkitSpeechRecognition']; });

  function montar() {
    const { api, llamadas } = dobleApi({
      myStockSources: { sucursal: { id: 'w1', code: '01', name: 'Padre Hidalgo' }, camioneta: null },
      getCustomer: cliente,
      catalogForCustomer: { priceListId: 'pl1', prices: [productoAltaRotacion] },
      // [VTK.11] La pantalla abre con catalogInstant (copia guardada o servidor).
      catalogInstant: { priceListId: 'pl1', prices: [productoAltaRotacion], origen: 'servidor', at: Date.now() },
      draftForCustomer: null,
      pendingForCustomer: [],
      frequentProducts: [],
      priceCoverage: { unpriced: 0 },
      ensureDraftForCustomer: { id: 'o1' },
      addLine: { id: 'l1' },
      orderById: { id: 'o1', lines: [] },
    });
    TestBed.configureTestingModule({
      imports: [VendorTakeOrderComponent],
      providers: [
        provideRouter([]),
        // [MCP.3.5] La pantalla usa el MessageService del shell /vendor (ya no declara el suyo).
        MessageService,
        { provide: VendorService, useValue: api },
        { provide: ConnectivityService, useValue: { isOnline: () => true } },
        { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve() } },
        { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } },
        },
      ],
    });
    const fixture = TestBed.createComponent(VendorTakeOrderComponent);
    fixture.detectChanges();
    return { fixture, llamadas, el: fixture.nativeElement as HTMLElement };
  }

  it('VendorService ya no expone los métodos de sugerencia ni de dictado', () => {
    expect('thotSuggest' in VendorService.prototype).toBe(false);
    expect('aiOrderSuggest' in VendorService.prototype).toBe(false);
    expect('recordSignal' in VendorService.prototype).toBe(false);
  });

  it('abrir el cliente no llama al motor de IA y pinta sin Sugeridos, micrófono ni "por qué"', () => {
    const { llamadas, el } = montar();
    expect(llamadas.filter((m) => METODOS_IA.includes(m))).toEqual([]);
    // Lo que sí debe pedir para pintar el pad.
    expect(llamadas).toEqual(
      expect.arrayContaining(['myStockSources', 'getCustomer', 'catalogInstant', 'frequentProducts']),
    );
    const texto = el.textContent || '';
    expect(texto).toContain('Catálogo · más vendidos');
    expect(texto).not.toContain('Sugeridos');
    expect(texto).not.toContain('por qué');
    expect(el.querySelector('button.mic')).toBeNull();
    expect(el.querySelector('[aria-label="Dictar pedido por voz"]')).toBeNull();
    // `rotation_tier` viene del catálogo, no del motor; aun así el chip ya no se pinta:
    // [MCP.3.5] se quitó de la tarjeta por pedido de ruta (ver vendor-tomar-pedido-avisos.spec.ts).
    expect(texto).not.toContain('Alta rotación');
  });

  it('tocar "+" no re-pide sugerencias después del debounce', fakeAsync(() => {
    const { fixture, llamadas, el } = montar();
    const mas = el.querySelector<HTMLButtonElement>('button[aria-label="Más"]');
    expect(mas).not.toBeNull();
    mas!.click();
    fixture.detectChanges();
    tick(3000);
    flush();
    expect(llamadas).toContain('addLine');
    expect(llamadas.filter((m) => METODOS_IA.includes(m))).toEqual([]);
  }));
});

describe('Mi ruta sin IA', () => {
  it('cargar la ruta no espera a /intelligence/nba ni pinta el banner "para reordenar"', () => {
    const { api, llamadas } = dobleApi({
      home: [
        {
          id: 'c1',
          code: 'CLI-1',
          name: 'Abarrotes Lupita',
          visited_today: false,
          has_preventa_pending: false,
          pending_count: 0,
          pending_total: 0,
          ordered_today: false,
        },
      ],
      myOrdersToday: [],
      dayPickState: null,
    });
    TestBed.configureTestingModule({
      imports: [VendorRouteHomeComponent],
      providers: [
        provideRouter([]),
        MessageService,
        { provide: VendorService, useValue: api },
        { provide: GeolocationService, useValue: { supported: false } },
        // [MCP.3.6] Mi ruta primero pregunta si la ruta de hoy está iniciada; aquí ya va en ruta.
        {
          provide: RouteDayService,
          useValue: {
            today: () =>
              of({ id: 'rd1', work_date: '2026-10-21', state: 'en_ruta', started_at: '2026-10-21T14:00:00.000Z', finished_at: null, visited: 0, orders: 0, total: 0 }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(VendorRouteHomeComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(llamadas).not.toContain('nbaDue');
    expect(llamadas.filter((m) => METODOS_IA.includes(m))).toEqual([]);
    expect(llamadas).toEqual(expect.arrayContaining(['home', 'myOrdersToday', 'dayPickState']));
    expect(el.textContent).toContain('Abarrotes Lupita');
    expect(el.textContent).not.toContain('para reordenar');
    expect(el.querySelector('.smart')).toBeNull();
    expect(el.querySelector('.chip.due')).toBeNull();

    // Abrir la hoja del cliente ya no manda la señal "offer_shown" al motor.
    el.querySelector<HTMLButtonElement>('button.client')!.click();
    expect(llamadas).not.toContain('recordSignal');
  });
});
