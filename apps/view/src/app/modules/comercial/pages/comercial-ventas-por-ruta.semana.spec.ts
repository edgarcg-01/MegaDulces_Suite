import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService, SalesByRouteDetail, SalesByRouteRow } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.42]` La pestaña «Por semana» del desglose de una ruta. Cifras de EJEMPLO.
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. La pestaña existe junto a «Por día» y pinta las semanas (se monta el template de verdad).
 *  2. Las semanas salen de los mismos días que «Por día» y suman lo mismo.
 *  3. El clic en una semana lleva a SUS tickets, con from/to de esa semana RECORTADOS al periodo
 *     del panel: si no, la S44 en noviembre traería tickets de octubre.
 *  4. Quitar filtros suelta la semana; elegir semana suelta el día.
 */

const DAILY = [
  { date: '2026-11-02', revenue: 1000, units: 10, tickets: 2 },
  { date: '2026-11-03', revenue: 2000, units: 20, tickets: 3 },
  { date: '2026-11-09', revenue: 500, units: 5, tickets: 1 },
];

function ruta(route_no: string): SalesByRouteRow {
  return {
    warehouse_code: '05', warehouse_name: 'Sucursal de ejemplo',
    route_code: route_no, route_no, label: `RUTA ${route_no}`,
    monthly: {}, revenue_total: 0, units_total: 0, tickets_total: 0, share_pct: 0,
  };
}

function montar() {
  const svc = {
    salesByRoute: vi.fn().mockReturnValue(of({ rows: [], months: [], totals: null })),
    salesByRouteRoutes: vi.fn().mockReturnValue(of([])),
    salesByRouteProducts: vi.fn().mockReturnValue(of([])),
    salesByRouteClients: vi.fn().mockReturnValue(of([])),
    salesByRouteDetail: vi.fn().mockReturnValue(of({
      route_no: '1V009', route_code: '1V009', warehouse_name: 'Sucursal de ejemplo', year: 2026,
      totals: { revenue: 3500, units: 35, tickets: 6, skus: 0, clients: 0, lines: 0 },
      per_client: {
        clients: 0, revenue: 0, public_revenue: 0, public_pct: 0, avg_revenue: null, avg_skus: null,
        avg_tickets: null, avg_lines: null, avg_units: null, avg_value_per_article: null, avg_unit_value: null,
      },
      daily: DAILY, products: [], clients: [], units_mix: [], tickets: [],
      margin: { revenue_with_cost: 0, cost: 0, margin_pct: null, coverage_pct: 0 },
    } satisfies SalesByRouteDetail)),
    salesByRouteTickets: vi.fn().mockReturnValue(of({ rows: [], total: 0 })),
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
  return { fix, cmp: fix.componentInstance as any, svc };
}

/** Los from/to de la ÚLTIMA petición del desglose. */
const ultimoRango = (svc: ReturnType<typeof montar>['svc']) => {
  const calls = svc.salesByRouteDetail.mock.calls;
  const opts = calls[calls.length - 1][2] as { from?: string; to?: string };
  return { from: opts.from, to: opts.to };
};

describe('VEC.42 · Ventas por ruta: pestaña «Por semana»', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T18:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('pinta las semanas al lado de «Por día», de la más reciente a la más vieja', () => {
    const { fix, cmp } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    cmp.setTab('semanas');
    fix.detectChanges();
    const html: string = fix.nativeElement.textContent;
    expect(html).toContain('Por día');
    expect(html).toContain('Por semana');
    expect(html).toContain('S46 · 9–15 nov');
    expect(html).toContain('en curso');
    const semanas = cmp.porSemana().semanas;
    expect(semanas.map((s: { etiqueta: string }) => s.etiqueta)).toEqual(['S46 · 9–15 nov', 'S45 · 2–8 nov']);
    // Control: las semanas suman lo mismo que los días.
    const suma = semanas.reduce((a: number, s: { revenue: number }) => a + s.revenue, 0);
    expect(suma).toBe(DAILY.reduce((a, d) => a + d.revenue, 0));
  });

  it('⛔ el clic en la semana pide sus tickets con from/to de ESA semana', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    cmp.drillWeek('2026-11-02');
    expect(cmp.dWeek()).toBe('2026-11-02');
    expect(cmp.tab()).toBe('tickets');
    expect(cmp.dWeekLabel()).toBe('S45 · 2–8 nov');
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-02', to: '2026-11-09' });
  });

  it('⛔ la semana cortada por el periodo se pide RECORTADA (no trae días de octubre)', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    cmp.drillWeek('2026-10-26');
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-01', to: '2026-11-02' });
  });

  it('elegir semana suelta el día, y «Quitar filtros» suelta la semana', () => {
    const { cmp } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    cmp.drillDay('2026-11-03');
    cmp.drillWeek('2026-11-09');
    expect(cmp.dDay()).toBeNull();
    expect(cmp.hasDrill()).toBe(true);
    cmp.clearDrill();
    expect(cmp.dWeek()).toBeNull();
    expect(cmp.hasDrill()).toBe(false);
  });

  it('abrir otra ruta no hereda la semana elegida en la anterior', () => {
    const { cmp } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    cmp.drillWeek('2026-11-02');
    cmp.openRoute(ruta('1V010'), '11');
    expect(cmp.dWeek()).toBeNull();
  });
});
