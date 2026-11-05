import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService, SalesByRouteRow } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.36]` — Filtro «Ruta directa / Vecinal» y la comparativa entre las dos.
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. **El criterio es el código** (`2V005` = vecinal, `25`/`501` = directa), el mismo del backend.
 *  2. **La comparativa ignora el filtro de tipo** —es lo que compara— pero respeta los demás:
 *     con la sucursal acotada, cuenta sólo esa sucursal.
 *  3. **Una ruta en $0 no es «ruta con venta»**: si contara, la venta por ruta bajaría sola.
 *  4. **`?tipo=` basura no filtra nada** (negativa): cae a «Todas».
 */

const fila = (route_no: string, warehouse_code: string, revenue: number, tickets: number): SalesByRouteRow => ({
  warehouse_code, warehouse_name: `Suc ${warehouse_code}`, route_code: `WIN-${route_no}`, route_no,
  label: route_no, monthly: { '10': { revenue, units: 0, tickets } },
  revenue_total: revenue, units_total: 0, tickets_total: tickets, share_pct: 0,
});

const REPORTE = {
  year: 2026, months: ['10'], generated_at: '', freshness: null,
  totals: { revenue: 0, units: 0, tickets: 0 }, monthly_totals: {},
  rows: [
    fila('25', '01', 600, 6),      // directa
    fila('501', '02', 400, 2),     // directa
    fila('2V005', '08', 300, 3),   // vecinal
    fila('1V001', '01', 100, 1),   // vecinal
    fila('3V001', '05', 0, 0),     // vecinal sin venta en el periodo
  ],
};

function montar(queryParams: Record<string, string> = {}) {
  const svc = {
    salesByRoute: vi.fn().mockReturnValue(of(REPORTE)),
    salesByRouteRoutes: vi.fn().mockReturnValue(of([])),
    salesByRouteProducts: vi.fn().mockReturnValue(of([])),
    salesByRouteClients: vi.fn().mockReturnValue(of([])),
  };
  TestBed.configureTestingModule({
    imports: [ComercialVentasPorRutaComponent],
    providers: [
      provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
      { provide: ComercialService, useValue: svc },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(queryParams) } } },
    ],
  });
  const cmp = TestBed.createComponent(ComercialVentasPorRutaComponent).componentInstance;
  return { cmp };
}

const rutas = (cmp: ComercialVentasPorRutaComponent) => cmp.filteredRows().map((r) => r.route_no);

describe('VEC.36 · Ventas por ruta: filtro directa/vecinal y comparativa', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('el filtro separa por CÓDIGO de ruta', () => {
    const { cmp } = montar();
    expect(cmp.report()?.rows.length).toBe(5); // control: el reporte sí cargó
    cmp.setTipo('vecinal');
    expect(rutas(cmp)).toEqual(['2V005', '1V001', '3V001']);
    cmp.setTipo('directa');
    expect(rutas(cmp)).toEqual(['25', '501']);
    expect(cmp.hasViewFilters()).toBe(true);
    cmp.clearViewFilters();
    expect(rutas(cmp).length).toBe(5);
  });

  it('el selector dice cuántas rutas hay detrás de cada opción', () => {
    const { cmp } = montar();
    expect(cmp.tipoOpts().map((o) => o.count)).toEqual([5, 2, 3]);
  });

  it('la comparativa: venta, peso, rutas CON venta, ticket promedio y venta por ruta', () => {
    const { cmp } = montar();
    cmp.setTipo('vecinal'); // ⛔ no debe cambiarla: compara los dos tipos
    const [d, v] = cmp.kindSummary();
    expect(d).toMatchObject({ kind: 'directa', revenue: 1000, routes: 2, tickets: 8, avgTicket: 125, perRoute: 500 });
    expect(v).toMatchObject({ kind: 'vecinal', revenue: 400, routes: 2, tickets: 4, avgTicket: 100, perRoute: 200 });
    expect(d.share + v.share).toBeCloseTo(100, 6);
    expect(cmp.showKindCompare()).toBe(true);
  });

  it('respeta los demás filtros de vista (sucursal)', () => {
    const { cmp } = montar();
    cmp.fBranch.set(['01']);
    const [d, v] = cmp.kindSummary();
    expect(d.revenue).toBe(600);
    expect(v.revenue).toBe(100);
  });

  it('sin uno de los dos tipos en pantalla, no se dibuja la comparativa', () => {
    const { cmp } = montar();
    cmp.fBranch.set(['02']); // sólo la 501
    expect(cmp.showKindCompare()).toBe(false);
  });

  it('`?tipo=vecinal` aterriza filtrada', () => {
    const { cmp } = montar({ tipo: 'vecinal' });
    expect(cmp.fTipo()).toBe('vecinal');
  });

  it('⛔ NEGATIVA — `?tipo=` basura no filtra nada', () => {
    const { cmp } = montar({ tipo: 'camion' });
    expect(cmp.fTipo()).toBe('todas');
    expect(rutas(cmp).length).toBe(5);
  });
});
