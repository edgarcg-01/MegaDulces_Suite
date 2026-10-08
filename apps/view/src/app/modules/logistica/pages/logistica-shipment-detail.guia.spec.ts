import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { LogisticaShipmentDetailComponent } from './logistica-shipment-detail.component';

/**
 * EMB.19 — «Nueva guía» en el detalle del embarque: ya no se teclea.
 *   · en un embarque de Kepler no existe: su guía sale de la hoja, con sus paradas;
 *   · en uno manual se eligen tripulación y horario; la comisión sale de la tarifa de la ruta del
 *     embarque y los viáticos del horario (regla de la beta), bloqueados;
 *   · sin ruta tarifada o sin horario, el botón no avanza y dice qué falta.
 *
 * Nombres y montos de prueba, inventados.
 */

function contestar(http: HttpTestingController, mapa: Array<[RegExp, unknown]>) {
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    const abiertas = http.match(() => true).filter((r: TestRequest) => !r.cancelled);
    if (!abiertas.length) return;
    for (const r of abiertas) {
      const hit = mapa.find(([re]) => re.test(r.request.urlWithParams));
      if (hit) r.flush(hit[1] as object);
      else r.flush(null, { status: 404, statusText: 'Not Found' });
    }
  }
}

const RUTA = { id: 'r1', name: 'RUTA PRUEBA', driver_commission: 120, helper_commission: 80, active: true };
const VIATICO = [
  { id: 'v1', category: 'viatico', key: 'viatico_cafe', value: 50, active: true },
  { id: 'v2', category: 'viatico', key: 'viatico_desayuno', value: 100, active: true },
  { id: 'v3', category: 'viatico', key: 'viatico_comida', value: 100, active: true },
  { id: 'v4', category: 'viatico', key: 'viatico_cena', value: 100, active: true },
];
const PERSONAS = [
  { id: 'd1', full_name: 'PRUEBA UNO', roles: ['chofer'], active: true },
  { id: 'd2', full_name: 'PRUEBA DOS', roles: ['ayudante'], active: true },
];
const base = {
  id: 'e1', folio: 'EMB-2026-00010', shipment_date: '2026-10-03', status: 'programado', type: 'entrega',
  freight_revenue: 0, cargo_value: 0, boxes_count: 0, total_weight_kg: 0, route_id: 'r1',
};

function montar(shipment: Record<string, unknown>, guias: unknown[] = []) {
  TestBed.configureTestingModule({
    imports: [LogisticaShipmentDetailComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'e1' })), snapshot: { paramMap: convertToParamMap({ id: 'e1' }) } } },
    ],
  });
  const f = TestBed.createComponent(LogisticaShipmentDetailComponent);
  const http = TestBed.inject(HttpTestingController);
  const mapa: Array<[RegExp, unknown]> = [
    [/\/shipments\/e1$/, shipment],
    [/\/gps-review$/, REVISION],
    [/\/guides(\?|$)/, guias],
    [/\/fleet\/drivers/, PERSONAS],
    [/\/config\/routes\/list/, [RUTA]],
    [/\/config(\?|$)/, VIATICO],
  ];
  f.detectChanges();
  contestar(http, mapa);
  const comp = f.componentInstance;
  comp.setTab('guides');
  f.detectChanges();
  return { f, http, comp, el: f.nativeElement as HTMLElement, responder: () => contestar(http, mapa) };
}

const REVISION = {
  estado: 'difiere', motivo: null, tolerancias: { minutos: 60, km: 0.2 },
  capturado: { salida: '06:30', llegada: '17:30', duerme_fuera: false, km: 40, viaticos: 200 },
  gps: { salida: '08:30', llegada: '17:30', duerme_fuera: false, km: 40, km_metodo: 'odometro', puntos: 300, viaticos: 100 },
  diferencias: ['Viáticos: con el horario del GPS serían $100.00 en vez de $200.00 (cambia desayuno).'],
};
const GUIA = { id: 'g1', number: 'GUIA-2026-00001', shipment_id: 'e1', type: 'entrega', status: 'pendiente',
  driver_id: 'd1', driver_commission: 120, helper1_commission: 0, helper2_commission: 0, overnight: false, per_diem_total: 200 };

const botonNuevaGuia = (el: HTMLElement) => [...el.querySelectorAll('button')].filter((b) => b.textContent?.includes('Nueva guía'));

describe('Detalle de embarque — «Nueva guía» (EMB.19)', () => {
  it('en un embarque de Kepler no hay «Nueva guía»: su guía sale de la hoja', () => {
    const { el, comp } = montar({ ...base, kepler_sucursal: '06', kepler_guia: '0009999' });
    expect(comp.canAddGuide()).toBe(false);
    expect(botonNuevaGuia(el)).toHaveLength(0);
    expect(el.textContent).toContain('sale de su hoja de Kepler');
  });

  it('en un embarque manual sí, y comisión y viáticos salen calculados', () => {
    const { el, comp, responder } = montar({ ...base, kepler_sucursal: null, kepler_guia: null });
    expect(botonNuevaGuia(el).length).toBeGreaterThan(0);
    comp.openCreateGuide();
    responder();
    // Sale 5:30, llega 16:00: café + desayuno + comida = $250 por persona.
    comp.guideForm.patchValue({ driver_id: 'd1', helper1_id: 'd2', departure_time: '05:30', arrival_time: '16:00' });
    expect(comp.guiaErrores()).toEqual([]);
    expect(comp.guiaComisiones()).toEqual({ driver_commission: 120, helper1_commission: 80, helper2_commission: 0 });
    expect(comp.guiaViaticos()!.total).toBe(500);
    expect(comp.guiaPersonas().map((p) => p.nombre)).toEqual(['PRUEBA UNO', 'PRUEBA DOS']);
  });

  it('crear manda sólo tripulación y horario: comisión y viáticos los calcula la API', () => {
    const { http, comp, responder } = montar({ ...base, kepler_sucursal: null, kepler_guia: null });
    comp.openCreateGuide();
    responder();
    comp.guideForm.patchValue({ driver_id: 'd1', departure_time: '08:00', arrival_time: '14:00', overnight: true });
    comp.createGuide();
    const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/logistics/guides'));
    expect(req.request.body).toEqual({
      shipment_id: 'e1', driver_id: 'd1', helper1_id: null, helper2_id: null,
      departure_time: '08:00', arrival_time: '14:00', overnight: true,
    });
  });

  it('sin ruta en el embarque no se crea, y dice por qué', () => {
    const { http, comp, responder } = montar({ ...base, route_id: null, kepler_sucursal: null, kepler_guia: null });
    comp.openCreateGuide();
    responder();
    comp.guideForm.patchValue({ driver_id: 'd1', departure_time: '08:00', arrival_time: '14:00' });
    expect(comp.guiaErrores()).toEqual(['El embarque no tiene ruta: sin ruta no se calcula la comisión.']);
    expect(comp.guiaComisiones()).toBeNull();
    comp.createGuide();
    expect(http.match((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('el chofer no aparece entre los ayudantes', () => {
    const { comp, responder } = montar({ ...base, kepler_sucursal: null, kepler_guia: null });
    comp.openCreateGuide();
    responder();
    comp.guideForm.patchValue({ driver_id: 'd1' });
    expect(comp.choferOptions().map((o) => o.value)).toEqual(['d1']);
    expect(comp.ayudanteOptions().map((o) => o.value)).toEqual(['d2']);
  });

  // ── EMB.21: la revisión con GPS ─────────────────────────────────────────────────────────

  it('al abrir Guías se pide la revisión con GPS y se pinta debajo de la guía', () => {
    const { f, el, comp, responder } = montar({ ...base, kepler_sucursal: '06', kepler_guia: '0009999' }, [GUIA]);
    responder();
    f.detectChanges();
    expect(comp.gpsReview()?.estado).toBe('difiere');
    const card = el.querySelector('app-revision-gps')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Difiere del GPS');
    expect(card.textContent).toContain('cambia desayuno');
  });

  it('sin guía no hay nada que revisar: no se pinta', () => {
    const { el } = montar({ ...base, kepler_sucursal: null, kepler_guia: null });
    expect(el.querySelector('app-revision-gps')).toBeNull();
  });
});
