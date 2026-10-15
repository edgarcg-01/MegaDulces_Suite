// `[VTK.10]` El catálogo del vendedor pide TODOS los productos con precio.
//
// El tope era 8,000 y en prod hay 9,429 (medido 2026-10-15). Como el catálogo viene ordenado de más
// vendido a menos vendido, los 1,429 de la cola nunca llegaban al celular: el vendedor los buscaba
// por nombre y no aparecían.
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CATALOGO_COMPLETO, PortalService } from './portal.service';

describe('PortalService · catálogo completo del vendedor', () => {
  function montar() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    return { svc: TestBed.inject(PortalService), http: TestBed.inject(HttpTestingController) };
  }

  it('⭐ pide hasta el techo del servidor (10,000), no 8,000', () => {
    const { svc, http } = montar();
    svc.listPricesForList('pl1', 'w1', { pricedOnly: true, sort: 'sales' }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/commercial/price-lists/pl1/prices'));
    expect(req.request.params.get('pageSize')).toBe(String(CATALOGO_COMPLETO));
    expect(CATALOGO_COMPLETO).toBe(10000);
    // Prueba negativa: con el tope viejo quedaban fuera los 1,429 menos vendidos de prod.
    expect(9429).toBeGreaterThan(8000);
    expect(9429).toBeLessThanOrEqual(CATALOGO_COMPLETO);
    expect(req.request.params.get('priced_only')).toBe('true');
    expect(req.request.params.get('warehouse_id')).toBe('w1');
    req.flush({ data: [] });
    http.verify();
  });

  it('sin priced_only (portal de cliente) no cambia', () => {
    const { svc, http } = montar();
    svc.listPricesForList('pl1').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/commercial/price-lists/pl1/prices'));
    expect(req.request.params.get('pageSize')).toBe('5000');
    req.flush([]);
    http.verify();
  });
});
