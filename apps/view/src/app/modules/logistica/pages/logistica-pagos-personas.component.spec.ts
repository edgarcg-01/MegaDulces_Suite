import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import type { OperacionDelReporte, ReporteDePagos } from '@megadulces/contracts';
import { LogisticaPagosPersonasComponent } from './logistica-pagos-personas.component';

/**
 * `[EMB.47]` — «Por persona»: la solicitud de gasto de cada quien en la catorcena. Es la MISMA
 * pantalla en Logística › Pagos de viaje y en Finanzas › Comisiones de logística. Se MONTA (eso
 * compila la plantilla, que tsc no mira) y se recorre: el reporte, una persona y moverse de corte.
 * Nombres y montos de prueba, inventados.
 */
const CORTE = { desde: '2026-09-24', hasta: '2026-10-07', pago: '2026-10-09' };
const op = (x: Partial<OperacionDelReporte>): OperacionDelReporte => ({
  sucursal: '00', guia: '0000001', fecha: '2026-09-30', paradas: 1, destinos: 'YURECUARO', tipo: 'traspaso', chofer_kepler: null,
  importe: 0, shipment_id: 's1', shipment_folio: null, guide_id: 'g1', driver_id: 'd1', helper1_id: null, helper2_id: null,
  departure_time: '06:00', arrival_time: '15:00', overnight: false, cargadores: 1, faltan: [], cajas: 100, tarifa_por_caja: 0.2,
  carga_total: 20, cargador_ids: ['c1'], renglones: [], repartido: 0, ...x,
});
const REPORTE: ReporteDePagos = {
  corte: CORTE,
  operaciones: [
    op({
      renglones: [
        { persona_id: 'd1', persona: 'CHOFER PRUEBA', rol: 'chofer', concepto: 'comision', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 129 },
        { persona_id: 'd1', persona: 'CHOFER PRUEBA', rol: 'chofer', concepto: 'viatico', codigo: '027', nombre_concepto: 'VIATICOS TRASPASO DE MERCANCIA', importe: 200 },
        { persona_id: 'c1', persona: 'CARGADOR PRUEBA', rol: 'cargador', concepto: 'carga', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 20 },
      ],
    }),
    op({ guia: '0000002', shipment_id: null, driver_id: null, faltan: ['chofer', 'horario', 'cargadores'], cargador_ids: [], cargadores: 0 }),
  ],
  fuera_de_alcance: 0, personas: [], leido_at: '2026-10-08T12:00:00.000Z',
};

function montar(titulo?: string) {
  TestBed.configureTestingModule({
    imports: [LogisticaPagosPersonasComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: titulo ? { titulo } : {} } } },
    ],
  });
  const f = TestBed.createComponent(LogisticaPagosPersonasComponent);
  const http = TestBed.inject(HttpTestingController);
  return { f, c: f.componentInstance, http, el: f.nativeElement as HTMLElement };
}
const reporte = (http: HttpTestingController) => http.expectOne((r) => r.url.endsWith('/logistics/trip-closure/reporte'));

describe('LogisticaPagosPersonasComponent', () => {
  beforeAll(() => registerLocaleData(localeEsMx));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('pide la catorcena vigente (sin fechas) y pinta lo que pide cada persona', async () => {
    const { f, http, el } = montar();
    const req = reporte(http);
    expect(req.request.params.keys()).toEqual([]);
    req.flush(REPORTE);
    f.detectChanges();
    await f.whenStable();
    expect(el.textContent).toContain('2 personas piden $349.00 en total esta catorcena.');
    expect(el.textContent).toContain('CHOFER PRUEBA');
    expect(el.textContent).toContain('$329.00');
  });

  it('declara las operaciones que todavía no tienen quién fue: lo suyo no se puede pedir', () => {
    const { f, c, http, el } = montar();
    reporte(http).flush(REPORTE);
    f.detectChanges();
    expect(c.pendientes().operaciones).toBe(1);
    expect(el.textContent).toContain('1 operación todavía sin quién fue');
  });

  it('al abrir a una persona: renglones para Kepler (concepto × destino) y de dónde sale cada peso', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.alSeleccionar(c.solicitudes().find((s) => s.persona === 'CHOFER PRUEBA'));
    expect(c.sel()?.renglones.map((r) => [r.codigo, r.destino, r.importe])).toEqual([['027', 'YURECUARO', 200], ['054', 'YURECUARO', 129]]);
    expect(c.sel()?.detalle).toHaveLength(2);
  });

  it('moverse de catorcena pide las fechas de 14 días antes y suelta a la persona abierta', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.alSeleccionar(c.solicitudes()[0]);
    c.mover(-1);
    const req = reporte(http);
    expect(req.request.params.get('desde')).toBe('2026-09-10');
    expect(req.request.params.get('hasta')).toBe('2026-09-23');
    req.flush({ ...REPORTE, corte: { desde: '2026-09-10', hasta: '2026-09-23', pago: '2026-09-25' }, operaciones: [] });
    expect(c.sel()).toBeNull();
  });

  it('desde Finanzas lleva su título y NO enlaza a Operaciones (allá puede no tener permiso); dentro de Pagos de viaje, al revés', () => {
    const fin = montar('Comisiones de logística');
    reporte(fin.http).flush(REPORTE);
    fin.f.detectChanges();
    expect(fin.el.querySelector('h1')?.textContent).toContain('Comisiones de logística');
    expect(fin.el.textContent).not.toContain('Ir a Operaciones');
    TestBed.resetTestingModule();
    const log = montar();
    reporte(log.http).flush(REPORTE);
    log.f.detectChanges();
    expect(log.el.querySelector('h1')).toBeNull();
    expect(log.el.textContent).toContain('Ir a Operaciones');
  });
});
