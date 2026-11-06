import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService, SalesByRouteRow } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.36]` — Filtro «Ruta directa / Vecinal» (la comparativa RD vs vecinal se retiró a pedido del PM, 2026-11-04).
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. **El criterio es el código** (`2V005` = vecinal, `25`/`501` = directa), el mismo del backend.
 *  2. **El tipo se suma a los demás filtros** (sucursal), y el conteo del selector los respeta.
 *  3. **`?tipo=` basura no filtra nada** (negativa): cae a «Todas».
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
  return { cmp, svc };
}

const rutas = (cmp: ComercialVentasPorRutaComponent) => cmp.filteredRows().map((r) => r.route_no);

describe('VEC.36 · Ventas por ruta: filtro directa/vecinal', () => {
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

  it('respeta los demás filtros de vista (sucursal)', () => {
    const { cmp } = montar();
    cmp.fBranch.set(['01']);
    cmp.setTipo('vecinal');
    expect(rutas(cmp)).toEqual(['1V001']);
    expect(cmp.tipoOpts().map((o) => o.count)).toEqual([2, 1, 1]);
  });

  it('`?tipo=vecinal` aterriza filtrada', () => {
    const { cmp } = montar({ tipo: 'vecinal' });
    expect(cmp.fTipo()).toBe('vecinal');
  });

  it('[VEC.37] «Solo activas» = vendió en alguno de los dos últimos meses, sin importar el rango', () => {
    const { cmp } = montar();
    cmp.report.set({
      ...REPORTE, months: ['08', '09', '10'],
      rows: [
        { ...fila('25', '01', 0, 0), monthly: { '08': { revenue: 50, units: 0, tickets: 1 } } },   // dejó de vender
        { ...fila('501', '02', 0, 0), monthly: { '09': { revenue: 70, units: 0, tickets: 1 } } },  // activa (sep)
        fila('2V005', '08', 300, 3),                                                              // activa (oct)
      ],
    } as never);
    expect(cmp.activeCount()).toBe(2);
    cmp.fOnlyActive.set(true);
    cmp.fMonthFrom.set('08'); cmp.fMonthTo.set('08'); // ⛔ el rango NO cambia quién es activa
    expect(rutas(cmp)).toEqual(['501', '2V005']);
    expect(cmp.activeHint()).toBe('Sep u Oct');
    cmp.setTipo('vecinal');
    expect(cmp.activeCount()).toBe(1);
    cmp.clearAllFilters();
    expect(cmp.fOnlyActive()).toBe(false);
    expect(rutas(cmp).length).toBe(3);
  });

  it('[VEC.37] limpiar la barra quita producto y cliente y re-consulta; sin ellos no re-consulta', () => {
    const { cmp, svc } = montar();
    const antes = svc.salesByRoute.mock.calls.length;
    cmp.fOnlyActive.set(true);
    cmp.clearAllFilters();
    expect(svc.salesByRoute.mock.calls.length).toBe(antes); // sólo vista: sin ir a la base
    cmp.fClient.set('20703');
    expect(cmp.hasAnyFilter()).toBe(true);
    cmp.clearAllFilters();
    expect(cmp.fClient()).toBeNull();
    expect(svc.salesByRoute.mock.calls.length).toBe(antes + 1);
  });

  it('⛔ NEGATIVA — `?tipo=` basura no filtra nada', () => {
    const { cmp } = montar({ tipo: 'camion' });
    expect(cmp.fTipo()).toBe('todas');
    expect(rutas(cmp).length).toBe(5);
  });
});
