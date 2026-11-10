// `[VTK.18]` Tomar pedido: el buscador acepta el código de barras leído con la cámara.
//
// El catálogo del pedido se busca por nombre y SKU (la clave de Kepler), no por código de barras.
// Lo leído se traduce a su clave (copia de precios del teléfono, o en línea) y se busca esa clave.
// Negativas: un código que no se pudo traducir NO se convierte en otro producto; «no está» y «no se
// pudo» se dicen distinto; teclear después borra el aviso de la lectura.
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Observable, of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { ChecadorPreciosService, type ClaveDeCodigo } from '../checador-precios.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, currency: 'MXN', sales_units_30d: 10, stock_available: 20 };
const dulce = { ...base, id: 'a', product_id: 'a', product_name: 'DULCE PRUEBA /12', sku: '00052', price: 8.78 };
const otro = { ...base, id: 'b', product_id: 'b', product_name: 'TAMARINDO PRUEBA 20P', sku: '14055', price: 6.5 };

function montar(resolver: (codigo: string, sucursal: string | null) => Promise<ClaveDeCodigo>) {
  // La pantalla abre con señal (sin ella entra al modo sin red, que es otra prueba); la señal se
  // puede quitar DESPUÉS, al leer el código.
  const red = { enLinea: true };
  const respuestas: Record<string, unknown> = {
    myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos', assigned: true }, camioneta: null },
    getCustomer: { id: 'c1', code: 'C1', name: 'Tienda Prueba', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogInstant: { priceListId: 'pl1', prices: [dulce, otro], origen: 'servidor', at: Date.now() },
    catalogForCustomer: { priceListId: 'pl1', prices: [dulce, otro] },
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return () => of(prop in respuestas ? respuestas[prop] : null) as Observable<unknown>;
    },
  }) as unknown as VendorService;
  const checador = { claveDeCodigo: vi.fn(resolver) };
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      { provide: MessageService, useValue: { add: () => void 0 } },
      { provide: VendorService, useValue: api },
      { provide: ChecadorPreciosService, useValue: checador },
      { provide: ConnectivityService, useValue: { isOnline: () => red.enLinea } },
      { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve(), cacheCustomer: () => Promise.resolve() } },
      { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fixture = TestBed.createComponent(VendorTakeOrderComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const texto = () => (el.textContent || '').replace(/\s+/g, ' ');
  return { fixture, cmp: fixture.componentInstance, el, texto, checador, red };
}

describe('Tomar pedido · buscar leyendo el código de barras [VTK.18]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('el buscador trae el botón de la cámara', () => {
    const { el } = montar(async () => ({ estado: 'no_se_pudo' }));
    const btn = el.querySelector('.search app-lector-codigo button');
    expect(btn?.getAttribute('aria-label')).toBe('Buscar leyendo el código de barras con la cámara');
  });

  it('⭐ lo leído se traduce a su clave y la lista muestra ESE producto', async () => {
    const { cmp, fixture, texto, checador } = montar(async () => ({ estado: 'hallado', clave: '00052', nombre: 'DULCE PRUEBA /12', ambiguo: false }));
    await cmp.alEscanear('840004096513');
    fixture.detectChanges();
    expect(checador.claveDeCodigo).toHaveBeenCalledWith('840004096513', '02');
    expect(cmp.searchTerm()).toBe('00052');
    expect(cmp.displayed().map((p) => p.product_id)).toEqual(['a']);
    expect(texto()).toContain('Leíste 840004096513: DULCE PRUEBA /12 (clave 00052).');
  });

  it('código en más de un producto: se busca uno y se AVISA que confirme', async () => {
    const { cmp, fixture, el } = montar(async () => ({ estado: 'hallado', clave: '00052', nombre: 'DULCE PRUEBA /12', ambiguo: true }));
    await cmp.alEscanear('7503008008816');
    fixture.detectChanges();
    const aviso = el.querySelector('.cat-age.warn')?.textContent || '';
    expect(aviso).toContain('está en más de un producto');
  });

  it('⛔ [negativa] código que Kepler no tiene: se busca tal cual y se dice; no se inventa un producto', async () => {
    const { cmp, fixture, texto } = montar(async () => ({ estado: 'no_esta' }));
    await cmp.alEscanear('7500000000000');
    fixture.detectChanges();
    expect(cmp.searchTerm()).toBe('7500000000000');
    expect(cmp.displayed()).toEqual([]);
    expect(texto()).toContain('El código 7500000000000 no está en el catálogo de Kepler');
  });

  it('⛔ [negativa] sin señal y sin copia: «no se pudo confirmar», no «no existe»', async () => {
    const { cmp, fixture, texto, red } = montar(async () => ({ estado: 'no_se_pudo' }));
    red.enLinea = false;
    await cmp.alEscanear('7500000000000');
    fixture.detectChanges();
    expect(texto()).toContain('No se pudo confirmar de qué producto es 7500000000000 (sin señal');
    expect(texto()).not.toContain('no está en el catálogo');
  });

  it('teclear después de leer borra el aviso, y una lectura lenta no pisa lo tecleado', async () => {
    let soltar: (r: ClaveDeCodigo) => void = () => undefined;
    const { cmp, fixture, el } = montar(() => new Promise((r) => { soltar = r; }));
    const p = cmp.alEscanear('840004096513');
    cmp.alBuscar('tamarindo');
    soltar({ estado: 'hallado', clave: '00052', nombre: 'DULCE PRUEBA /12', ambiguo: false });
    await p;
    fixture.detectChanges();
    expect(cmp.searchTerm()).toBe('tamarindo');
    expect(el.querySelector('.cat-age .pi-camera')).toBeNull();
  });
});
