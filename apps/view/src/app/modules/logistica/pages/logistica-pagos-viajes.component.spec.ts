import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { BandejaDeViajes, ViajePorCompletar } from '@megadulces/contracts';
import { LogisticaPagosViajesComponent } from './logistica-pagos-viajes.component';

/**
 * `[EMB.43]` — «Por completar»: los viajes de Kepler de la catorcena y lo que les falta. Se MONTA
 * (eso compila la plantilla) y se recorre: la bandeja, el filtro, tomar un viaje y completar su
 * guía. Nombres, folios y montos inventados.
 */
const v = (o: Partial<ViajePorCompletar>): ViajePorCompletar => ({
  sucursal: '06', guia: '0000002', fecha: '2026-10-10', paradas: 2, destinos: 'CLIENTE PRUEBA', tipo: 'cliente',
  chofer_kepler: null, importe: 500.5, shipment_id: null, shipment_folio: null, guide_id: null, driver_id: null,
  helper1_id: null, helper2_id: null, departure_time: null, arrival_time: null, overnight: false, cargadores: 0,
  faltan: ['tomar'], ...o,
});
const SIN_TOMAR = v({});
const SIN_HORARIO = v({
  sucursal: '01', guia: '0000004', tipo: 'mixto', chofer_kepler: 'CHOFER DOS', shipment_id: 's-d', shipment_folio: 'EMB-D',
  guide_id: 'g-d', driver_id: 'd2', faltan: ['horario', 'cargadores'],
});
const COMPLETO = v({
  sucursal: '00', guia: '0000001', tipo: 'traspaso', shipment_id: 's-a', shipment_folio: 'EMB-A', guide_id: 'g-a', driver_id: 'd1',
  departure_time: '05:30', arrival_time: '16:10', cargadores: 2, faltan: [],
});
const BANDEJA: BandejaDeViajes = {
  corte: { desde: '2026-10-08', hasta: '2026-10-21', pago: '2026-10-23' },
  viajes: [SIN_HORARIO, SIN_TOMAR, COMPLETO], fuera_de_alcance: 1,
  personas: [{ id: 'd1', full_name: 'PERSONA UNO', roles: ['chofer'] }, { id: 'd2', full_name: 'PERSONA DOS', roles: ['chofer'] },
    { id: 'a1', full_name: 'AYUDANTE PRUEBA', roles: ['ayudante'] }],
  leido_at: '2026-10-24T18:00:00.000Z',
};

function montar() {
  TestBed.configureTestingModule({
    imports: [LogisticaPagosViajesComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const f = TestBed.createComponent(LogisticaPagosViajesComponent);
  const http = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}
const bandeja = (http: HttpTestingController) => http.expectOne((r) => r.url.endsWith('/logistics/trip-closure/bandeja'));

describe('LogisticaPagosViajesComponent', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('pide la catorcena que va corriendo (sin fechas) y dice cuántos viajes faltan', () => {
    const { f, http, el } = montar();
    const req = bandeja(http);
    expect(req.request.params.keys()).toEqual([]);
    req.flush(BANDEJA);
    f.detectChanges();
    expect(el.textContent).toContain('De 3 viajes de la catorcena, 1 están completos y a 2 les falta algo');
    expect(el.textContent).toContain('Falta el horario');
    expect(el.textContent).toContain('Sin hoja en la Suite');
  });

  it('abre en «Por completar»: los completos no aparecen hasta pedirlos', () => {
    const { c, http } = montar();
    bandeja(http).flush(BANDEJA);
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000004', '0000002']);
    c.vista.set('completos');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000001']);
    c.vista.set('todos');
    c.busqueda.set('emb-d');
    expect(c.filtrados().map((x) => x.guia)).toEqual(['0000004']);
  });

  it('tomar un viaje sin hoja manda sólo el tipo de entrega y relee la bandeja', () => {
    const { c, http } = montar();
    bandeja(http).flush(BANDEJA);
    c.abrir(SIN_TOMAR);
    c.tomar(SIN_TOMAR);
    http.expectNone((r) => r.method === 'POST');
    c.tipoEntrega.set('long_trip');
    c.tomar(SIN_TOMAR);
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/shipments/from-kepler/06/0000002'));
    expect(post.request.body).toEqual({ delivery_type: 'long_trip' });
    post.flush({ shipment: { id: 's-b', folio: 'EMB-B', status: 'programado', kepler_sucursal: '06', kepler_guia: '0000002' }, guide: { id: 'g-b', number: 'G', status: 'pendiente' }, destinatarios: 2 });
    expect(c.avisoPeek()).toContain('EMB-B');
    bandeja(http).flush(BANDEJA);
  });

  it('completar la guía manda horario en HH:MM y NO manda chofer cuando Kepler ya lo trajo', () => {
    const { c, http } = montar();
    bandeja(http).flush(BANDEJA);
    c.abrir(SIN_HORARIO);
    c.ayudante1.set('a1');
    c.salida.set(new Date(2026, 9, 10, 5, 7));
    c.llegada.set(new Date(2026, 9, 10, 16, 45));
    expect(c.erroresGuia(SIN_HORARIO)).toEqual([]);
    c.guardarGuia(SIN_HORARIO);
    const post = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/guides/g-d/complete'));
    expect(post.request.body).toEqual({ helper1_id: 'a1', helper2_id: null, departure_time: '05:07', arrival_time: '16:45', overnight: false });
    post.flush({ id: 'g-d', number: 'G', driver_commission: 180, helper1_commission: 120, helper2_commission: 0, per_diem_total: 200 });
    expect(c.avisoPeek()).toContain('$300.00');
    bandeja(http).flush(BANDEJA);
  });

  it('PRUEBA NEGATIVA: sin horario, o con la misma persona dos veces, no se manda nada', () => {
    const { c, http } = montar();
    bandeja(http).flush(BANDEJA);
    c.abrir(SIN_HORARIO);
    expect(c.erroresGuia(SIN_HORARIO)).toContain('Captura la hora de salida.');
    c.guardarGuia(SIN_HORARIO);
    c.salida.set(new Date(2026, 9, 10, 6, 0));
    c.llegada.set(new Date(2026, 9, 10, 14, 0));
    c.ayudante1.set('d2');
    expect(c.erroresGuia(SIN_HORARIO)).toContain('Una persona no puede ir dos veces en el mismo viaje.');
    c.guardarGuia(SIN_HORARIO);
    http.expectNone((r) => r.method === 'POST');
  });

  it('moverse de catorcena pide las fechas 14 días antes', () => {
    const { c, http } = montar();
    bandeja(http).flush(BANDEJA);
    c.mover(-1);
    const req = bandeja(http);
    expect(req.request.params.get('desde')).toBe('2026-09-24');
    expect(req.request.params.get('hasta')).toBe('2026-10-07');
    req.flush({ ...BANDEJA, corte: { desde: '2026-09-24', hasta: '2026-10-07', pago: '2026-10-09' }, viajes: [] });
  });
});
