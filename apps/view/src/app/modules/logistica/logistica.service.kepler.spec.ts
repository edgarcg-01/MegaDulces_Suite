import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LogisticaService } from './logistica.service';

/**
 * EMB.12 — Las tres llamadas nuevas de `LogisticaService`. Se prueba la petición que SALE:
 * que un filtro vacío no viaje como texto «null», que sucursal y guía vayan en la ruta, y que
 * el cuerpo de la toma llegue intacto.
 */

function montar() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { api: TestBed.inject(LogisticaService), http: TestBed.inject(HttpTestingController) };
}

describe('LogisticaService — viajes de Kepler', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('listKeplerTrips manda sólo los filtros puestos', () => {
    const { api, http } = montar();
    api.listKeplerTrips({ fecha: '2026-10-03', sucursal: null, solo_sin_tomar: false }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/logistics/erp-shipments/trips'));
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys().sort()).toEqual(['fecha', 'limit']);
    expect(req.request.params.get('limit')).toBe('200');
    req.flush({ rows: [] });
  });

  it('listKeplerTrips con sucursal y sólo sin tomar', () => {
    const { api, http } = montar();
    api.listKeplerTrips({ fecha: '2026-10-03', sucursal: '06', solo_sin_tomar: true, limit: 50 }).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/logistics/erp-shipments/trips'));
    expect(req.request.params.get('sucursal')).toBe('06');
    expect(req.request.params.get('solo_sin_tomar')).toBe('true');
    expect(req.request.params.get('limit')).toBe('50');
    req.flush({ rows: [] });
  });

  it('getNuevoEmbarque pide la hoja de esa sucursal y guía', () => {
    const { api, http } = montar();
    api.getNuevoEmbarque('06', '0001419').subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/logistics/erp-shipments/trips/06/0001419/nuevo-embarque'));
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('createShipmentFromKepler manda lo capturado a la guía correcta', () => {
    const { api, http } = montar();
    const body = { delivery_type: 'route' as const, actual_km: 186, notes: null };
    api.createShipmentFromKepler('06', '0001419', body).subscribe();
    const req = http.expectOne((r) => r.url.endsWith('/logistics/shipments/from-kepler/06/0001419'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(body);
    req.flush({ shipment: { id: 'e1' }, guide: {}, destinatarios: 13 });
  });

  it('una guía con caracteres raros no rompe la ruta', () => {
    const { api, http } = montar();
    api.getNuevoEmbarque('06', 'G/1').subscribe();
    http.expectOne((r) => r.url.endsWith('/erp-shipments/trips/06/G%2F1/nuevo-embarque')).flush({});
  });
});
