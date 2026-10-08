import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { fechaLocal, ShipmentFormDialogComponent } from './shipment-form-dialog.component';

/**
 * El formulario de «Embarque manual» (lo que Kepler no emite). Dos defectos que se arreglaron con
 * EMB.12:
 *   · la fecha salía de `toISOString()`: con la hora actual por defecto, después de las 18:00 en
 *     México se guardaba el día SIGUIENTE;
 *   · «Por ruta / Viaje largo» se pedía y no se mandaba (no existía la columna).
 */

describe('fechaLocal', () => {
  it('usa el día local aunque la hora ya sea «mañana» en UTC', () => {
    expect(fechaLocal(new Date(2026, 9, 3, 19, 30))).toBe('2026-10-03');
    expect(fechaLocal(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05');
  });
});

describe('ShipmentFormDialogComponent — embarque manual', () => {
  it('manda la fecha local y el tipo de entrega', () => {
    TestBed.configureTestingModule({
      imports: [ShipmentFormDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const f = TestBed.createComponent(ShipmentFormDialogComponent);
    const http = TestBed.inject(HttpTestingController);
    f.detectChanges();
    http.match(() => true).forEach((r) => r.flush([]));

    const c = f.componentInstance;
    c.form.patchValue({ shipment_date: new Date(2026, 9, 3, 19, 30), type: 'recoleccion', delivery_type: 'long_trip' });
    c.submit();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/shipments'));
    expect(req.request.body).toMatchObject({ shipment_date: '2026-10-03', type: 'recoleccion', delivery_type: 'long_trip' });
    req.flush({ id: 's1', folio: 'EMB-2026-00001' });
  });
});

/**
 * EMB.19 — la sección «Asignar guía» ya no se teclea: se eligen tripulación y horario; la comisión
 * sale de la tarifa de la ruta elegida y los viáticos del horario. Nombres inventados.
 */
describe('ShipmentFormDialogComponent — guía calculada (EMB.19)', () => {
  function montar() {
    TestBed.configureTestingModule({
      imports: [ShipmentFormDialogComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const f = TestBed.createComponent(ShipmentFormDialogComponent);
    const http = TestBed.inject(HttpTestingController);
    f.detectChanges();
    for (const r of http.match(() => true)) {
      const u = r.request.urlWithParams;
      if (u.includes('/fleet/drivers')) r.flush([
        { id: 'd1', full_name: 'PRUEBA UNO', roles: ['chofer'], active: true },
        { id: 'd2', full_name: 'PRUEBA DOS', roles: ['ayudante'], active: true },
      ]);
      else if (u.includes('/config/routes/list')) r.flush([{ id: 'r1', name: 'RUTA PRUEBA', driver_commission: 120, helper_commission: 80 }]);
      else if (u.includes('/config')) r.flush([
        { key: 'viatico_cafe', value: 50 }, { key: 'viatico_desayuno', value: 100 },
        { key: 'viatico_comida', value: 100 }, { key: 'viatico_cena', value: 100 },
      ]);
      else r.flush([]);
    }
    return { f, http, c: f.componentInstance };
  }

  it('comisión de la ruta y viáticos del horario, y el margen los resta', () => {
    const { c } = montar();
    c.setIncludeGuide(true);
    c.form.patchValue({ route_id: 'r1', freight_revenue: 2000,
      guide: { driver_id: 'd1', helper1_id: 'd2', departure_time: '05:30', arrival_time: '21:00' } });
    expect(c.guiaErrores()).toEqual([]);
    expect(c.guiaComisiones()).toEqual({ driver_commission: 120, helper1_commission: 80, helper2_commission: 0 });
    expect(c.guiaViaticos()!.total).toBe(700); // café+desayuno+comida+cena = 350 por persona
    expect(c.estimatedMargin()).toBe(2000 - 200 - 700);
  });

  it('con la guía incompleta no se crea ni el embarque', () => {
    const { c, http } = montar();
    c.setIncludeGuide(true);
    c.form.patchValue({ guide: { driver_id: 'd1' } });
    expect(c.guiaErrores()).toContain('El embarque no tiene ruta: sin ruta no se calcula la comisión.');
    c.submit();
    expect(http.match((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('la guía se manda sin montos: los calcula la API', () => {
    const { c, http } = montar();
    c.setIncludeGuide(true);
    c.form.patchValue({ route_id: 'r1', guide: { driver_id: 'd1', departure_time: '08:00', arrival_time: '14:00' } });
    c.submit();
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/shipments')).flush({ id: 's1', folio: 'EMB-2026-00001' });
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/guides'));
    expect(req.request.body).toEqual({
      shipment_id: 's1', driver_id: 'd1', helper1_id: null, helper2_id: null,
      departure_time: '08:00', arrival_time: '14:00', overnight: false,
    });
  });
});

