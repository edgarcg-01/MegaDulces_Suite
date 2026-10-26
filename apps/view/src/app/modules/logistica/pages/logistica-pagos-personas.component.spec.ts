import { TestBed } from '@angular/core/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
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
  carga_total: 20, cargador_ids: ['c1'], renglones: [], repartido: 0, sueltos: 0, chofer_kepler_id: null,
  comision_ruta: { chofer: 129, ayudante: 0, ruta: 'LA PIEDAD', sin_tarifa: [] }, ...x,
});
const REPORTE: ReporteDePagos = {
  corte: CORTE,
  operaciones: [
    op({
      renglones: [
        { persona_id: 'd1', persona: 'CHOFER PRUEBA', rol: 'chofer', concepto: 'comision', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 129, fuente: 'kepler', calculo: 'Tarifa de la ruta YURECUARO: $129.00 al chofer' },
        { persona_id: 'd1', persona: 'CHOFER PRUEBA', rol: 'chofer', concepto: 'viatico', codigo: '027', nombre_concepto: 'VIATICOS TRASPASO DE MERCANCIA', importe: 200, fuente: 'captura', calculo: 'CALCULO PRUEBA' },
        { persona_id: 'c1', persona: 'CARGADOR PRUEBA', rol: 'cargador', concepto: 'carga', codigo: '054', nombre_concepto: 'COMISION ARRASTRE MERCANCIA', importe: 20, fuente: 'captura', calculo: 'CALCULO PRUEBA' },
      ],
    }),
    op({ guia: '0000002', shipment_id: null, driver_id: null, faltan: ['chofer', 'horario', 'cargadores'], cargador_ids: [], cargadores: 0 }),
  ],
  fuera_de_alcance: 0, solo_tiempo_aire: 0, personas: [], leido_at: '2026-10-08T12:00:00.000Z',
};

function montar(titulo?: string, query: Record<string, string> = {}) {
  TestBed.configureTestingModule({
    imports: [LogisticaPagosPersonasComponent],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: titulo ? { titulo } : {}, queryParamMap: convertToParamMap(query) } } },
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

  it('[EMB.51] un renglón de Kepler filtra «De dónde sale» a sus operaciones; «ver todas» lo quita', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.alSeleccionar(c.solicitudes().find((s) => s.persona === 'CHOFER PRUEBA'));
    expect(c.detalleVisible()).toHaveLength(2);
    c.alFiltrar(c.renglonesDeSel().find((r) => r.codigo === '027'));
    expect(c.detalleVisible().map((d) => [d.codigo, d.calculo])).toEqual([['027', 'CALCULO PRUEBA']]);
    c.filtro.set(null);
    expect(c.detalleVisible()).toHaveLength(2);
  });

  it('[EMB.51] una guía se abre en el mismo panel: lo que le toca de ella y su movimiento; «volver» regresa', () => {
    const { f, c, http } = montar();
    reporte(http).flush(REPORTE);
    c.alSeleccionar(c.solicitudes().find((s) => s.persona === 'CHOFER PRUEBA'));
    c.verOperacion(c.sel()!.detalle[0]);
    const req = http.expectOne((r) => r.url.endsWith('/trip-closure/operaciones/00/0000001/desglose'));
    expect(c.lineasDeOperacion().map((l) => l.codigo)).toEqual(['054', '027']);
    req.flush({ sucursal: '00', guia: '0000001', cajas: 100, sueltos: 0, leido_at: '2026-10-26T15:00:00.000Z', documentos: [] });
    f.detectChanges();
    expect(c.desgloseOp()?.cajas).toBe(100);
    c.cerrarOperacion();
    expect(c.opAbierta()).toBeNull();
  });

  it('[EMB.51] PRUEBA NEGATIVA: si llega tarde el movimiento de OTRA guía, no pisa el de la abierta', () => {
    const { c, http } = montar();
    reporte(http).flush(REPORTE);
    c.alSeleccionar(c.solicitudes().find((s) => s.persona === 'CHOFER PRUEBA'));
    c.verOperacion(c.sel()!.detalle[0]);
    const vieja = http.expectOne((r) => r.url.includes('/desglose'));
    c.verOperacion({ ...c.sel()!.detalle[0], guia: '0000009' });
    const nueva = http.expectOne((r) => r.url.includes('/0000009/desglose'));
    nueva.flush({ sucursal: '00', guia: '0000009', cajas: 9, sueltos: 0, leido_at: 'x', documentos: [] });
    vieja.flush({ sucursal: '00', guia: '0000001', cajas: 100, sueltos: 0, leido_at: 'x', documentos: [] });
    expect(c.desgloseOp()?.guia).toBe('0000009');
  });

  it('[EMB.51] la liga desde «Operaciones» abre la catorcena pedida con la solicitud de esa persona', () => {
    const { c, http } = montar(undefined, { persona: 'c1', desde: '2026-09-24', hasta: '2026-10-07' });
    const req = reporte(http);
    expect(req.request.params.get('desde')).toBe('2026-09-24');
    req.flush(REPORTE);
    expect(c.sel()?.persona).toBe('CARGADOR PRUEBA');
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
