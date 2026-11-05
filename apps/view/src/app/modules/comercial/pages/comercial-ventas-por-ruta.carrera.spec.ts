import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, Subject } from 'rxjs';
import { ComercialService, SalesByRouteRow } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.40]` — **«Elijo una ruta y me sale otra».**
 *
 * El desglose tarda de 1 a 7 s. Abrir la ruta A y en seguida la B dejaba dos peticiones en vuelo,
 * y la que llegaba ÚLTIMA ganaba — no la que el usuario pidió último. Si A respondía después, el
 * panel quedaba con los números de A bajo la fila, los depósitos y el arqueo de B.
 *
 * ⭐ La prueba entrega las respuestas EN DESORDEN (B primero, A después): con un doble que responde
 * en el orden de llamada, la carrera no existe y la prueba pasaría sin el arreglo.
 */

function ruta(route_no: string, warehouse_code: string): SalesByRouteRow {
  return {
    warehouse_code, warehouse_name: warehouse_code,
    route_code: `WIN-${route_no}`, route_no, label: `Ruta ${route_no}`,
    monthly: {}, revenue_total: 0, units_total: 0, tickets_total: 0, share_pct: 0,
  };
}

const desglose = (route_code: string) =>
  ({ route_code, daily: [], products: [], clients: [], units: [], tickets: null }) as never;

function montar() {
  // Un Subject POR LLAMADA: cada respuesta se entrega cuando la prueba decide.
  const detalles: Subject<unknown>[] = [];
  const tickets: Subject<unknown>[] = [];
  const reportes: Subject<unknown>[] = [];
  const pedir = (lista: Subject<unknown>[]) => () => { const s = new Subject<unknown>(); lista.push(s); return s; };
  const svc = {
    salesByRoute: vi.fn().mockImplementation(pedir(reportes)),
    salesByRouteRoutes: vi.fn().mockReturnValue(of([])),
    salesByRouteProducts: vi.fn().mockReturnValue(of([])),
    salesByRouteClients: vi.fn().mockReturnValue(of([])),
    salesByRouteDetail: vi.fn().mockImplementation(pedir(detalles)),
    salesByRouteTickets: vi.fn().mockImplementation(pedir(tickets)),
    vecinalConciliacion: vi.fn().mockReturnValue(of({ filas: [] })),
    routeCreditSales: vi.fn().mockReturnValue(of({ filas: [], summary: null })),
  };
  TestBed.configureTestingModule({
    imports: [ComercialVentasPorRutaComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: ComercialService, useValue: svc },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
    ],
  });
  const fix = TestBed.createComponent(ComercialVentasPorRutaComponent);
  return { cmp: fix.componentInstance as any, detalles, tickets, reportes };
}

describe('VEC.40 · la respuesta vieja no pisa a la ruta que el usuario eligió', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ abrir A y luego B: si A responde DESPUÉS, el panel sigue en B', () => {
    const { cmp, detalles } = montar();
    cmp.openRoute(ruta('1V004', '04'));
    cmp.openRoute(ruta('1V002', '01'));
    expect(detalles.length).toBe(2);

    detalles[1].next(desglose('WIN-1V002'));
    expect(cmp.detail()?.route_code).toBe('WIN-1V002');
    expect(cmp.detailLoading()).toBe(false);

    // La de 1V004 llega tarde: no se pinta.
    detalles[0].next(desglose('WIN-1V004'));
    expect(cmp.detail()?.route_code).toBe('WIN-1V002');
  });

  it('⛔ mientras B no llega, una respuesta de A tampoco se pinta (ni apaga el «cargando»)', () => {
    const { cmp, detalles } = montar();
    cmp.openRoute(ruta('1V004', '04'));
    cmp.openRoute(ruta('1V002', '01'));
    detalles[0].next(desglose('WIN-1V004'));
    expect(cmp.detail()).toBeNull();
    expect(cmp.detailLoading()).toBe(true);
  });

  it('⛔ los tickets de la ruta anterior no se pintan en la nueva', () => {
    const { cmp, detalles, tickets } = montar();
    cmp.openRoute(ruta('1V004', '04'));
    detalles[0].next(desglose('WIN-1V004'));
    cmp.loadTickets(true);
    expect(tickets.length).toBe(1);

    cmp.openRoute(ruta('1V002', '01'));
    tickets[0].next({ rows: [{ key: 'de-1V004' }], total: 1 });
    expect(cmp.tkPage()).toBeNull();
  });

  it('⛔ el reporte: gana el último filtro pedido, no la última respuesta', () => {
    const { cmp, reportes } = montar();
    // El constructor ya pidió uno (reportes[0]); se cambia el filtro y se pide otro.
    cmp.load();
    expect(reportes.length).toBe(2);
    reportes[1].next({ rows: [], months: ['10'], totals: null });
    reportes[0].next({ rows: [], months: ['01'], totals: null });
    expect(cmp.report()?.months).toEqual(['10']);
  });
});
