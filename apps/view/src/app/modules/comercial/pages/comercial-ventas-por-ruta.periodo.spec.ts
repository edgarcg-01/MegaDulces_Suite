import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { ComercialService, SalesByRouteDetail, SalesByRouteRow } from '../comercial.service';
import { ComercialVentasPorRutaComponent } from './comercial-ventas-por-ruta.component';

/**
 * `[VEC.44]` El periodo del desglose de una ruta es un CALENDARIO de rango (reemplaza a la pestaña
 * «Calendario» por semanas de `[VEC.43]`). Cifras de EJEMPLO.
 *
 * ── Qué se vigila ────────────────────────────────────────────────────────────────────────────
 *  1. Al abrir, el calendario muestra las fechas que se están viendo (el mes, topado a hoy).
 *  2. Elegir dos fechas pide ESE rango, hasta el último día incluido; una sola fecha pide ese día.
 *  3. Los tickets se piden con el mismo rango que el resto del desglose.
 *  4. Elegir lo mismo que ya se ve no vuelve a pedir; «Limpiar» regresa al mes de apertura.
 *  5. Otro periodo suelta el día elegido y el arqueo pedido con el anterior.
 *  6. Abrir otra ruta no hereda el rango; la pestaña por semanas ya no existe.
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

/** Lo que muestra el calendario, en `YYYY-MM-DD` (fechas locales). */
const enCalendario = (cmp: any): string[] =>
  (cmp.rangoCal() ?? []).map((d: Date | null) =>
    d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);

/** Elegir en el calendario y cerrarlo (lo que hace la persona). */
const elegir = (cmp: any, a: Date, b: Date | null) => {
  cmp.rangoCal.set([a, b]);
  cmp.aplicarRango();
};

describe('VEC.44 · Ventas por ruta: el periodo del desglose es un calendario de rango', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('al abrir, el calendario muestra el mes que se está viendo, topado a hoy, y no hay pestaña por semanas', () => {
    const { fix, cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    fix.detectChanges();
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-01', to: '2026-12-01' });
    expect(enCalendario(cmp)).toEqual(['2026-11-01', '2026-11-11']);
    const el: HTMLElement = fix.nativeElement;
    expect(el.querySelector('p-datepicker')).toBeTruthy();
    const pestanas = [...el.querySelectorAll('.rr-tabs button')].map((b) => b.textContent?.trim());
    expect(pestanas).toContain('Por día');
    expect(pestanas).not.toContain('Calendario');
  });

  it('⛔ dos fechas piden ESE rango, con el último día incluido, y los tickets van con el mismo', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    elegir(cmp, new Date(2026, 10, 3), new Date(2026, 10, 5));
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-03', to: '2026-11-06' });
    expect(cmp.scopeLabel()).toBe('03/11/2026 al 05/11/2026');
    expect(enCalendario(cmp)).toEqual(['2026-11-03', '2026-11-05']);
    const tk = cmp.ticketParams();
    expect({ from: tk.from, to: tk.to }).toEqual({ from: '2026-11-03', to: '2026-11-06' });
  });

  it('una sola fecha pide ese día', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    elegir(cmp, new Date(2026, 10, 3), null);
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-03', to: '2026-11-04' });
    expect(cmp.scopeLabel()).toBe('03/11/2026');
  });

  it('el rango puede cruzar meses (no lo encierra el mes con que se abrió)', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    elegir(cmp, new Date(2026, 9, 28), new Date(2026, 10, 2));
    expect(ultimoRango(svc)).toEqual({ from: '2026-10-28', to: '2026-11-03' });
    expect(cmp.dMonth()).toBeNull();
  });

  it('[negativa] elegir las mismas fechas que ya se ven no vuelve a pedir', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    const antes = svc.salesByRouteDetail.mock.calls.length;
    elegir(cmp, new Date(2026, 10, 1), new Date(2026, 10, 11));
    expect(svc.salesByRouteDetail.mock.calls.length).toBe(antes);
    // Cerrar sin fechas tampoco: el calendario vuelve a mostrar lo vigente.
    cmp.rangoCal.set(null);
    cmp.aplicarRango();
    expect(svc.salesByRouteDetail.mock.calls.length).toBe(antes);
    expect(enCalendario(cmp)).toEqual(['2026-11-01', '2026-11-11']);
  });

  it('«Limpiar» regresa al mes con que se abrió la ruta; «Todo el año» quita los límites', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    elegir(cmp, new Date(2026, 10, 3), new Date(2026, 10, 5));
    cmp.limpiarRango();
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-01', to: '2026-12-01' });
    cmp.verAnioCompleto();
    expect(ultimoRango(svc)).toEqual({ from: undefined, to: undefined });
    expect(enCalendario(cmp)).toEqual(['2026-01-01', '2026-11-11']);
  });

  it('lo que se puede elegir es el año del reporte, hasta hoy', () => {
    const { cmp } = montar();
    const { min, max } = cmp.calLimites();
    expect(min).toEqual(new Date(2026, 0, 1));
    expect(max.getMonth()).toBe(10);
    expect(max.getDate()).toBe(11);
    // El mismo objeto en cada lectura: un Date nuevo por ciclo sería un cambio por ciclo.
    expect(cmp.calLimites()).toBe(cmp.calLimites());
  });

  it('otro periodo suelta el día elegido y el arqueo pedido con el anterior', () => {
    const { cmp } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    cmp.drillDay('2026-11-09');
    cmp.arqData.set({ filas: [] });
    elegir(cmp, new Date(2026, 10, 2), new Date(2026, 10, 3));
    expect(cmp.dDay()).toBeNull();
    expect(cmp.arqData()).toBeNull();
  });

  describe('el ticket abierto: total de lo que vendió al pie', () => {
    const detalle = (revenue: number | string, importes: (number | string)[]) => ({
      key: 'k1', source: 'kepler_vecinal', route_no: '1V009', folio: 'T001', date: '2026-11-03', time: '10:00',
      doc_type: 'ticket', client_code: 'C1', client_name: 'TIENDA DE EJEMPLO', is_public: false,
      payment_method: '01', payment_method_label: 'Efectivo', seller: null, lines: importes.length, skus: importes.length,
      units: 10, revenue, cost: null, margin_pct: null, warehouse_name: 'Sucursal de ejemplo',
      lines_detail: importes.map((importe, i) => ({
        sku: `S${i}`, name: `PRODUCTO ${i}`, unidad: 'PZA', unidad_origen: 'catalogo', qty: 1, boxes: null, box_factor: null,
        precio_unitario: Number(importe), importe, costo: null, margin_pct: null, iva: null, ieps: null,
      })),
    });
    const pintarTicket = (d: unknown) => {
      const { fix, cmp } = montar();
      cmp.openRoute(ruta('1V009'), '11');
      cmp.setTab('tickets');
      cmp.ticket.set(d);
      fix.detectChanges();
      return { cmp, texto: (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '' };
    };

    it('suma los renglones al pie, también si el importe llega como texto', () => {
      const { cmp, texto } = pintarTicket(detalle('492.63', ['252.08', 240.55]));
      expect(cmp.ticketTotal()).toEqual({ renglones: 492.63, diferencia: null });
      expect(texto).toContain('Total del ticket');
      expect(texto).toContain('$492.63');
      // [negativa] si cuadran, no hay aviso.
      expect(texto).not.toContain('no cuadran');
    });

    it('⛔ si los renglones no suman el importe del ticket, lo DICE con la diferencia', () => {
      const { cmp, texto } = pintarTicket(detalle(500, [252.08, 240.55]));
      expect(cmp.ticketTotal().diferencia).toBe(7.37);
      expect(texto).toContain('no cuadran por $7.37');
    });
  });

  it('abrir otra ruta no hereda el rango elegido en la anterior', () => {
    const { cmp, svc } = montar();
    cmp.openRoute(ruta('1V009'), '11');
    elegir(cmp, new Date(2026, 10, 3), new Date(2026, 10, 5));
    cmp.openRoute(ruta('1V010'), '11');
    expect(cmp.dRango()).toBeNull();
    expect(ultimoRango(svc)).toEqual({ from: '2026-11-01', to: '2026-12-01' });
  });
});
