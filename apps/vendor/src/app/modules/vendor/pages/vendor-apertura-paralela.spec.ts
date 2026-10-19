// `[VTK.13]` Abrir un cliente en Tomar pedido sin viajes de red en serie.
//
// Antes: borrador, pendientes y habituales esperaban a que respondieran fuentes + cliente (sin
// depender de ellos), y las listas de precio abrían OTRO viaje después del cliente. Cada viaje en
// red de campo es latencia completa; encadenados, la pantalla no bajaba del segundo.
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { VendorService } from '../vendor.service';
import { AuthService } from '../../../core/services/auth.service';
import { OfflineDatabaseService } from '../../../core/services/offline-database.service';
import { ConnectivityService } from '../../../core/services/connectivity.service';
import { OfflineOrderService } from '../../../core/services/offline-order.service';
import { HapticService } from '../../../core/services/haptic.service';
import { VendorTakeOrderComponent } from './vendor-take-order.component';

describe('Tomar pedido · todo sale a la vez al abrir', () => {
  it('⭐ borrador, pendientes, habituales y listas salen ANTES de que responda el cliente', () => {
    const llamadas: string[] = [];
    const cliente$ = new Subject<unknown>();
    const respuestas: Record<string, unknown> = {
      myStockSources: { sucursal: { id: 'w1', code: '02', name: 'La Piedad Abastos' }, camioneta: null },
      catalogInstant: { priceListId: 'pl1', prices: [], origen: 'servidor', at: Date.now() },
      draftForCustomer: null,
      pendingForCustomer: [],
      frequentProducts: [],
      precalentarListas: [],
      priceCoverage: { unpriced: 0 },
    };
    const api = new Proxy({}, {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return () => {
          llamadas.push(prop);
          return prop === 'getCustomer' ? cliente$ : of(prop in respuestas ? respuestas[prop] : null);
        };
      },
    }) as unknown as VendorService;
    TestBed.configureTestingModule({
      imports: [VendorTakeOrderComponent],
      providers: [
        provideRouter([]),
        { provide: VendorService, useValue: api },
        { provide: ConnectivityService, useValue: { isOnline: () => true } },
        { provide: OfflineOrderService, useValue: { cacheContext: () => Promise.resolve(), cacheCustomer: () => Promise.resolve() } },
        { provide: HapticService, useValue: { selection: () => void 0, notification: () => void 0 } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
      ],
    });
    const fixture = TestBed.createComponent(VendorTakeOrderComponent);
    fixture.detectChanges();

    // El cliente sigue en vuelo. Prueba negativa: con la cascada vieja aquí sólo había
    // ['myStockSources', 'getCustomer'] y lo demás esperaba.
    expect(llamadas).toEqual(
      expect.arrayContaining(['myStockSources', 'getCustomer', 'precalentarListas', 'draftForCustomer', 'pendingForCustomer', 'frequentProducts']),
    );
    // El catálogo sí necesita al cliente (su lista de precios): ése es el único encadenado.
    expect(llamadas).not.toContain('catalogInstant');
    expect(fixture.componentInstance.loading()).toBe(true);

    cliente$.next({ id: 'c1', code: 'C1', name: 'Super San Juan', credit_limit: 0, active: true, default_price_list_id: 'pl1' });
    cliente$.complete();
    expect(llamadas).toContain('catalogInstant');
    expect(fixture.componentInstance.loading()).toBe(false);
    expect(fixture.componentInstance.customer()?.name).toBe('Super San Juan');
    expect(fixture.componentInstance.stockWarehouseId()).toBe('w1');
  });
});

describe('VendorService · lo que es igual para toda la ruta se pide una vez', () => {
  function montar() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user: () => ({ sub: 'u1' }) } },
        { provide: OfflineDatabaseService, useValue: { getVendorCatalog: () => Promise.resolve(undefined) } },
      ],
    });
    return { svc: TestBed.inject(VendorService), http: TestBed.inject(HttpTestingController) };
  }

  it('⭐ fuentes de existencia: el 2º cliente no vuelve a la red', () => {
    const { svc, http } = montar();
    const fuentes = { sucursal: { id: 'w1', code: '02', name: 'X' }, camioneta: null };
    let a: unknown;
    let b: unknown;
    svc.myStockSources().subscribe((r) => (a = r));
    // Una 2ª apertura mientras la 1ª está en vuelo comparte la petición.
    svc.myStockSources().subscribe((r) => (b = r));
    http.expectOne((r) => r.url.endsWith('/vendor-routes/my-stock-sources')).flush(fuentes);
    let c: unknown;
    svc.myStockSources().subscribe((r) => (c = r));
    http.expectNone((r) => r.url.endsWith('/vendor-routes/my-stock-sources'));
    expect([a, b, c]).toEqual([fuentes, fuentes, fuentes]);
    http.verify();
  });

  it('un error no se guarda: la siguiente apertura vuelve a pedir', () => {
    const { svc, http } = montar();
    let fallo = false;
    svc.myStockSources().subscribe({ error: () => (fallo = true) });
    http.expectOne((r) => r.url.endsWith('/vendor-routes/my-stock-sources')).flush('x', { status: 503, statusText: 'down' });
    expect(fallo).toBe(true);
    svc.myStockSources().subscribe();
    http.expectOne((r) => r.url.endsWith('/vendor-routes/my-stock-sources')).flush({ sucursal: null, camioneta: null });
    http.verify();
  });

  it('⭐ listas de precio: precalentar + catálogo = UN solo viaje', () => {
    const { svc, http } = montar();
    svc.precalentarListas().subscribe();
    const cliente = { id: 'c1', default_price_list_id: 'pl1' } as Parameters<VendorService['catalogInstant']>[0];
    svc.catalogInstant(cliente, 'w1').subscribe();
    http.expectOne((r) => r.url.endsWith('/commercial/price-lists')).flush([{ id: 'pl1', is_default: true }]);
    http.expectNone((r) => r.url.endsWith('/commercial/price-lists'));
  });
});
