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
