import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { LogisticaShipmentDetailComponent } from './logistica-shipment-detail.component';
import { hojaGuia0001419 } from '../../../../testing/nuevo-embarque.fixture';

/**
 * EMB.12 — La HOJA FINAL dentro del detalle del embarque.
 *
 * El detalle es una pantalla grande con muchas peticiones; esta prueba las contesta por URL y
 * mira sólo lo que EMB.12 agregó: que un embarque tomado de Kepler lea su viaje EN VIVO y pinte la
 * hoja con entregas y costo, que uno propio no lo intente, y que sin permiso de gastos la hoja
 * salga igual con el gasto declarado «sin medir».
 */

type Respuesta = unknown | ((r: TestRequest) => unknown) | { __error: number };

function contestar(http: HttpTestingController, mapa: Array<[RegExp, Respuesta]>) {
  // Una respuesta puede disparar otra petición (la hoja pide el costo), así que se repite.
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const abiertas = http.match(() => true).filter((r) => !r.cancelled);
    if (!abiertas.length) return;
    for (const r of abiertas) {
      const hit = mapa.find(([re]) => re.test(r.request.urlWithParams));
      const v = hit ? (typeof hit[1] === 'function' ? (hit[1] as (r: TestRequest) => unknown)(r) : hit[1]) : null;
      if (v && typeof v === 'object' && '__error' in (v as object)) {
        r.flush({ message: 'x' }, { status: (v as { __error: number }).__error, statusText: 'x' });
      } else if (hit) r.flush(v as object);
      else r.flush(null, { status: 404, statusText: 'Not Found' });
    }
  }
}

function montar(shipment: Record<string, unknown>, costos: Respuesta = { total: 2661.22, familias: [], conceptos: [] }) {
  TestBed.configureTestingModule({
    imports: [LogisticaShipmentDetailComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'e1' })), snapshot: { paramMap: convertToParamMap({ id: 'e1' }) } } },
    ],
  });
  const f = TestBed.createComponent(LogisticaShipmentDetailComponent);
  const http = TestBed.inject(HttpTestingController);
  f.detectChanges();
  const pedidas: string[] = [];
  contestar(http, [
    [/\/shipments\/e1$/, () => { pedidas.push('shipment'); return shipment; }],
    [/\/guides\/g1$/, { id: 'g1', recipients: [
      { id: 'r1', guide_id: 'g1', customer_name: 'x', boxes_count: 67, weight_kg: 0, value: 0, status: 'entregado', kepler_folio: '0001052', kepler_serie: '1' },
    ] }],
    [/\/guides(\?|$)/, [{ id: 'g1', number: 'GUIA-2026-00001', shipment_id: 'e1', type: 'entrega', status: 'pendiente',
      driver_id: 'd1', driver_commission: 103.2, helper1_id: 'd2', helper1_commission: 63.84,
      helper2_id: null, helper2_commission: 0, overnight: false, per_diem_total: 0, departure_time: '08:00:00', arrival_time: '17:00:00' }]],
    [/nuevo-embarque$/, () => { pedidas.push('hoja'); return hojaGuia0001419(); }],
    [/erp-shipments\/costs\/06\/0001419/, costos],
    [/\/fleet\/drivers/, [{ id: 'd1', full_name: 'César C.', roles: ['chofer'], active: true }, { id: 'd2', full_name: 'Manuel M.', roles: ['ayudante'], active: true }]],
  ]);
  f.detectChanges();
  return { f, el: f.nativeElement as HTMLElement, pedidas };
}

const base = {
  id: 'e1', folio: 'EMB-2026-00010', shipment_date: '2026-10-03', status: 'programado', type: 'entrega',
  freight_revenue: 0, cargo_value: 159596.2, boxes_count: 190, total_weight_kg: 0,
  origin: 'Sucursal Canindo', destination: 'JIQUILPAN · SAHUAYO',
};

describe('Detalle de embarque — hoja final de Kepler (EMB.12)', () => {
  it('un embarque tomado de Kepler lee el viaje en vivo y pinta la hoja con entregas y costo', () => {
    const { el, pedidas } = montar({ ...base, kepler_sucursal: '06', kepler_guia: '0001419' });
    expect(pedidas).toContain('hoja');
    const hoja = el.querySelector('app-kepler-hoja')!;
    expect(hoja).not.toBeNull();
    expect(hoja.querySelector('thead')!.textContent).toContain('Entrega');
    expect(hoja.querySelector('tbody tr')!.textContent).toContain('Entregado');
    const costo = el.querySelector('app-kepler-costo')!.textContent!.replace(/\s+/g, ' ');
    expect(costo).toContain('Chofer · César C.');
    expect(costo).toContain('$2,828.26');
  });

  it('un embarque propio de la app no pide nada a Kepler', () => {
    const { el, pedidas } = montar({ ...base, kepler_sucursal: null, kepler_guia: null });
    expect(pedidas).not.toContain('hoja');
    expect(el.querySelector('app-kepler-hoja')).toBeNull();
  });

  it('sin permiso de gastos la hoja sale igual y el gasto de Kepler queda «sin medir»', () => {
    const { el } = montar({ ...base, kepler_sucursal: '06', kepler_guia: '0001419' }, { __error: 403 });
    const costo = el.querySelector('app-kepler-costo')!.textContent!;
    expect(costo).toContain('Sin medir');
    expect(costo).toContain('Sin permiso para ver gastos');
  });
});
