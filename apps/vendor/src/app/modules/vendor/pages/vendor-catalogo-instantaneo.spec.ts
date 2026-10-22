// `[VTK.11]` Abrir un cliente con el catálogo que el celular ya tiene, y refrescarlo detrás.
//
// Medido en prod el 2026-10-15: el catálogo tardaba 13.7–18.1 s en cada apertura y era el mismo
// para todos los clientes de la ruta. La prueba monta la pantalla real con un doble de
// VendorService que ANOTA cada método llamado, así mide qué sale a la red al abrir.
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';

const base = { price_list_id: 'pl1', tax_rate: 0.16, min_qty: 1, stock_available: 50, currency: 'MXN', sales_units_30d: 10 };
const viejo = { ...base, id: 'a', product_id: 'a', product_name: 'Kinder Delice 10P', sku: '1', price: 17 };
const nuevo = { ...base, id: 'b', product_id: 'b', product_name: 'Serenata de Amor 825g', sku: '2', price: 123.75 };

function montar(instantaneo: { origen: 'memoria' | 'telefono' | 'servidor'; at: number }, fresco: unknown = { priceListId: 'pl1', prices: [viejo, nuevo] }) {
  const llamadas: string[] = [];
  const respuestas: Record<string, unknown> = {
    myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
    getCustomer: { id: 'c1', code: 'C1', name: 'Super San Juan', credit_limit: 0, active: true, default_price_list_id: 'pl1' },
    catalogInstant: { priceListId: 'pl1', prices: [viejo], ...instantaneo },
    catalogForCustomer: fresco,
    draftForCustomer: null,
    pendingForCustomer: [],
    frequentProducts: [],
    priceCoverage: { unpriced: 0 },
  };
  const api = new Proxy({}, {
    get: (_t, prop: string | symbol) => {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return () => { llamadas.push(prop); return of(prop in respuestas ? respuestas[prop] : null); };
    },
  }) as unknown as VendorService;
  const guardado: string[] = [];
  const offline = {
    cacheContext: () => { guardado.push('catalogo+cliente'); return Promise.resolve(); },
    cacheCustomer: () => { guardado.push('cliente'); return Promise.resolve(); },
  };
  TestBed.configureTestingModule({
    imports: [VendorTakeOrderComponent],
    providers: [
      provideRouter([]),
      // [MCP.3.5] La pantalla usa el MessageService del shell /vendor (ya no declara el suyo).
      MessageService,
      { provide: VendorService, useValue: api },
      { provide: ConnectivityService, useValue: { isOnline: () => true } },
      { provide: OfflineOrderService, useValue: offline },
      { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fixture = TestBed.createComponent(VendorTakeOrderComponent);
  fixture.detectChanges();
  const cmp = fixture.componentInstance;
  return { fixture, cmp, llamadas, guardado, el: fixture.nativeElement as HTMLElement };
}

describe('Tomar pedido · abrir con el catálogo guardado', () => {
  it('⭐ con copia del celular de hace 10 min: abre con ella y baja la nueva detrás', () => {
    const { cmp, llamadas, guardado, fixture, el } = montar({ origen: 'telefono', at: Date.now() - 10 * 60_000 });
    expect(llamadas).toContain('catalogInstant');
    // Detrás se bajó la nueva y reemplazó a la copia (trae un producto más).
    expect(llamadas.filter((m) => m === 'catalogForCustomer')).toHaveLength(1);
    expect(cmp.prices().map((p) => p.product_id)).toEqual(['a', 'b']);
    expect(cmp.catalogo()?.origen).toBe('servidor');
    fixture.detectChanges();
    expect(el.querySelector('.cat-age')).toBeNull();
    // Al abrir sólo se guarda el cliente; el catálogo se reescribe cuando llega el nuevo.
    expect(guardado).toEqual(['cliente', 'catalogo+cliente']);
  });

  it('⭐ con copia de esta sesión de hace 30 s: no toca la red para el catálogo', () => {
    const { cmp, llamadas, fixture, el } = montar({ origen: 'memoria', at: Date.now() - 30_000 });
    // Prueba negativa: antes cada apertura bajaba el catálogo completo (aquí sería 1).
    expect(llamadas).not.toContain('catalogForCustomer');
    expect(cmp.prices().map((p) => p.product_id)).toEqual(['a']);
    fixture.detectChanges();
    // Y dice de cuándo es lo que se ve.
    expect(el.querySelector('.cat-age')?.textContent).toContain('Precios y existencia de hace un momento');
  });

  it('si la recarga de fondo falla, se queda la copia y se dice', () => {
    const { cmp, fixture, el } = montar({ origen: 'telefono', at: Date.now() - 3 * 60 * 60_000 }, { priceListId: '', prices: [] });
    expect(cmp.prices().map((p) => p.product_id)).toEqual(['a']);
    fixture.detectChanges();
    const aviso = el.querySelector('.cat-age');
    expect(aviso?.textContent).toContain('hace 3 h · no se pudo actualizar');
    expect(aviso?.classList.contains('warn')).toBe(true);
  });

  it('recién bajado del servidor: no hay aviso ni segunda descarga', () => {
    const { llamadas, guardado, fixture, el } = montar({ origen: 'servidor', at: Date.now() });
    expect(llamadas).not.toContain('catalogForCustomer');
    expect(guardado).toEqual(['catalogo+cliente']);
    fixture.detectChanges();
    expect(el.querySelector('.cat-age')).toBeNull();
  });
});
