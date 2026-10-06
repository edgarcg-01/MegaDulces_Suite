import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { hoyLocal, LogisticaNuevoEmbarqueComponent, sumarValor } from './logistica-nuevo-embarque.component';
import { KeplerTripRow } from '../logistica.service';

/**
 * EMB.12 — «Nuevo embarque», paso 1: elegir el viaje de Kepler. Se monta con TestBed para que
 * compile el template y se prueba contra la petición REAL que sale (fecha + sólo sin tomar).
 */

const fila = (over: Partial<KeplerTripRow> = {}): KeplerTripRow => ({
  sucursal: '06', guia_embarque: '0001419', guia_digital: '06-G0001419', fecha: '2026-10-03',
  paradas: 13, destinos: 7, series: 1, transporte_code: '00017', transporte_descripcion: 'FORD 450 GASOLINA SUPER DUTY',
  transporte_placas: 'NC-1134-D', chofer_code: '00017', chofer_nombre: 'CESAR C.', chofer_falta: false,
  tipo_etiqueta: 'Entrega a cliente', total: '159596.20', vehicle_id: null, vehicle_plate: null,
  destinos_texto: 'CENTRO, JIQUILPAN · CENTRO, SAHUAYO', tomado_shipment_id: null, tomado_folio: null,
  ...over,
});

function montar() {
  TestBed.configureTestingModule({
    imports: [LogisticaNuevoEmbarqueComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const f = TestBed.createComponent(LogisticaNuevoEmbarqueComponent);
  const http = TestBed.inject(HttpTestingController);
  f.detectChanges();
  return { f, http, el: f.nativeElement as HTMLElement };
}

describe('hoyLocal / sumarValor', () => {
  it('hoyLocal usa la fecha LOCAL, no la de UTC', () => {
    expect(hoyLocal(new Date(2026, 9, 3, 23, 30))).toBe('2026-10-03');
  });
  it('sumarValor suma en centavos', () => {
    expect(sumarValor([{ total: '0.1' }, { total: '0.2' }])).toBe(0.3);
  });
});

describe('LogisticaNuevoEmbarqueComponent', () => {
  it('pide los viajes del día que faltan de tomar', () => {
    const { http } = montar();
    const req = http.expectOne((r) => r.url.endsWith('/logistics/erp-shipments/trips'));
    expect(req.request.params.get('fecha')).toBe(hoyLocal());
    expect(req.request.params.get('solo_sin_tomar')).toBe('true');
    req.flush({ rows: [], page: 1, limit: 200, total: 0 });
  });

  it('pinta cada viaje con su acción, y el chofer que falta como aviso', () => {
    const { f, http, el } = montar();
    http.expectOne(() => true).flush({
      rows: [fila(), fila({ sucursal: '01', guia_embarque: '0001626', guia_digital: '01-G0001626', chofer_code: null, chofer_nombre: null, chofer_falta: true })],
      page: 1, limit: 200, total: 2,
    });
    f.detectChanges();
    const filas = [...el.querySelectorAll('tbody tr')];
    expect(filas).toHaveLength(2);
    expect(filas[0].textContent).toContain('Listo para tomar');
    expect(filas[1].textContent).toContain('No viene en Kepler');
    expect(filas[1].textContent).toContain('Falta chofer');
    const link = filas[0].querySelector('a[aria-label="Tomar el viaje 06-G0001419"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/logistica/shipments/nuevo/06/0001419');
    // KPI: un viaje sin chofer pendiente de tomar.
    expect(el.textContent).toContain('Sin chofer en Kepler');
  });

  it('un viaje ya tomado lleva a su embarque, no a tomarlo otra vez', () => {
    const { f, http, el } = montar();
    http.expectOne(() => true).flush({
      rows: [fila({ tomado_shipment_id: 'e1', tomado_folio: 'EMB-2026-00012' })], page: 1, limit: 200, total: 1,
    });
    f.detectChanges();
    const tr = el.querySelector('tbody tr')!;
    expect(tr.textContent).toContain('Tomado · EMB-2026-00012');
    expect(tr.querySelector('a')!.getAttribute('href')).toBe('/logistica/shipments/e1');
  });

  it('sin viajes dice por qué y ofrece el día anterior', () => {
    const { f, http, el } = montar();
    http.expectOne(() => true).flush({ rows: [], page: 1, limit: 200, total: 0 });
    f.detectChanges();
    expect(el.textContent).toContain('Sin viajes para tomar');
    const boton = [...el.querySelectorAll('button')].find((b) => b.textContent!.includes('Ver el día anterior'))!;
    boton.click();
    const req = http.expectOne(() => true);
    const [y, m, d] = hoyLocal().split('-').map(Number);
    expect(req.request.params.get('fecha')).toBe(hoyLocal(new Date(y, m - 1, d - 1)));
    req.flush({ rows: [], page: 1, limit: 200, total: 0 });
  });

  it('si Kepler no responde, lo dice y deja reintentar', () => {
    const { f, http, el } = montar();
    http.expectOne(() => true).flush({ message: 'ODS sin conexión' }, { status: 503, statusText: 'x' });
    f.detectChanges();
    expect(el.textContent).toContain('No se pudo leer Kepler');
    expect(el.textContent).toContain('ODS sin conexión');
  });
});
