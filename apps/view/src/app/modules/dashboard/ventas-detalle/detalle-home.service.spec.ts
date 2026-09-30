// @vitest-environment jsdom
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { DetalleHomeService } from './detalle-home.service';
import { ComercialService } from '../../comercial/comercial.service';
import { of, firstValueFrom } from 'rxjs';

/** Periodo actual: RD con costo (margen 20,000) + vecinal sin costo. */
const DASH_CUR = {
  series: [
    { date: '2026-09-01', revenue: 150000, lines: 900, tickets: 250, cost: 40000 },
    { date: '2026-09-02', revenue: 150000, lines: 900, tickets: 250, cost: null },
  ],
  by_route: [
    { route_code: 'WIN-21', route_no: '21', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
      revenue: 100000, subtotal: 100000, lines: 600, tickets: 200, cost: 80000, revenue_with_cost: 100000 },
    { route_code: 'WIN-VEC-PH-H', route_no: 'VEC-PH-H', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
      revenue: 200000, subtotal: 200000, lines: 1200, tickets: 300, cost: null, revenue_with_cost: 0 },
  ],
  coverage: { revenue: 300000, revenue_with_cost: 100000, cost: 80000, margin_pct: 20,
    cost_coverage_pct: 33.3, data_as_of: '2026-09-30', data_from: '2026-03-14' },
};
/** Periodo previo: la mitad de todo. */
const DASH_PREV = {
  series: [],
  by_route: [
    { route_code: 'WIN-21', route_no: '21', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
      revenue: 50000, subtotal: 50000, lines: 300, tickets: 100, cost: 40000, revenue_with_cost: 50000 },
  ],
  coverage: { revenue: 150000, revenue_with_cost: 50000, cost: 40000, margin_pct: 20,
    cost_coverage_pct: 33.3, data_as_of: '2026-08-31', data_from: '2026-02-12' },
};

describe('DetalleHomeService', () => {
  let service: DetalleHomeService;
  let mockHttpClient: any;
  let mockComercialService: any;

  beforeEach(() => {
    mockHttpClient = {
      get: vi.fn().mockReturnValue(of({})),
    };
    mockComercialService = {
      salesByRoute: vi.fn().mockReturnValue(of({
        year: 2026,
        rows: [
          {
            route_code: 'WIN-21',
            route_no: '21',
            warehouse_code: '01',
            warehouse_name: 'Padre Hidalgo',
            monthly: {
              '09': { revenue: 100000, tickets: 200, units: 1000, lines: 600 },
            },
          },
          {
            route_code: 'WIN-VEC-PH-H',
            route_no: 'VEC-PH-H',
            warehouse_code: '01',
            warehouse_name: 'Padre Hidalgo',
            monthly: {
              '09': { revenue: 200000, tickets: 300, units: 2500, lines: 1200 },
            },
          },
        ],
      })),
      salesByRouteRoutes: vi.fn().mockReturnValue(of([
        {
          value: 'WIN-21',
          label: 'R-21 Padre Hidalgo',
          warehouse_code: '01',
          warehouse_name: 'Padre Hidalgo',
          route_code: 'WIN-21',
          route_no: '21',
        },
      ])),
      salesByRouteProducts: vi.fn().mockReturnValue(of([])),
      salesByRouteClients: vi.fn().mockReturnValue(of([])),
      /**
       * `[AUD-DAT.18/21]` La fuente REAL de los KPIs: el agregado del MISMO rango de fechas, por
       * ruta. Sin este doble el servicio tronaba (`salesByRouteDashboard is not a function`) y la
       * prueba seguía afirmando el tablero de ANTES, el que inventaba clientes y unidades.
       *
       * El periodo actual trae una ruta RD con costo y una vecinal SIN costo (el push de
       * camionetas no lo trae): el margen tiene que salir sólo de lo que tiene costo.
       */
      salesByRouteDashboard: vi.fn().mockImplementation((from: string) => of(
        from === '2026-09-01' ? DASH_CUR : DASH_PREV,
      )),
    };

    TestBed.configureTestingModule({
      providers: [
        DetalleHomeService,
        { provide: HttpClient, useValue: mockHttpClient },
        { provide: ComercialService, useValue: mockComercialService },
      ],
    });

    service = TestBed.inject(DetalleHomeService);
  });

  it('debe cargar el catálogo de rutas con formato DetalleRouteCatalogItem', async () => {
    const catalog = await firstValueFrom(service.loadRoutesCatalog());
    expect(catalog).toBeDefined();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog[0].value).toBe('WIN-21');
    expect(catalog[0].label).toBe('R-21 Padre Hidalgo');
  });

  /**
   * ⚠️ Esta prueba CAMBIÓ DE CONTRATO con `[AUD-DAT.21]`, y a propósito. Antes exigía `> 0` en
   * clientes, unidades por ticket, valor por unidad y venta por cliente — que el servicio sacaba
   * de fórmulas sobre el número de ruta (clientes = tickets × 0.45, canasta = 4.8 fija). Ninguna
   * fuente trae clientes ni unidades para este tablero, así que hoy se DECLARAN en `null`
   * (ADR-056). Exigirles `> 0` era exigir que volvieran a inventarse.
   */
  it('calcula los KPIs medibles desde la fuente real y DECLARA en null los que no tiene', async () => {
    const report = await firstValueFrom(
      service.getDetalleReport({ from: '2026-09-01', to: '2026-09-30', canal: 'all' }),
    );
    const k = report.kpis;

    // Lo que SÍ se mide, al número exacto del doble.
    expect(k.revenue.cur).toBe(300000);
    expect(k.revenue.prev).toBe(150000);
    expect(k.revenue.delta_pct).toBe(100);
    expect(k.tickets.cur).toBe(500);
    expect(k.avg_ticket.cur).toBe(600);
    expect(k.basket.cur).toBe(3.6);            // 1,800 renglones / 500 tickets — no un 4.8 fijo
    expect(k.avg_line.cur).toBe(166.67);
    // El margen sale SÓLO de lo que tiene costo: 100,000 − 80,000. Nunca de la venta total.
    expect(k.margin.cur).toBe(20000);
    expect(k.margin_pct.cur).toBe(20);

    // Lo que NO trae ninguna fuente: null, nunca un número inventado ni un cero.
    expect(k.units_per_ticket.cur).toBeNull();
    expect(k.avg_unit.cur).toBeNull();
    expect(k.customers.cur).toBeNull();
    expect(k.revenue_per_customer.cur).toBeNull();

    // Canales RD y Vecinal, y el vecinal sin costo no inventa margen.
    expect(report.channels.rd.canal).toBe('rd');
    expect(report.channels.vecinal.canal).toBe('vecinal');
    expect(report.channels.rd.revenue).toBe(100000);
    expect(report.channels.vecinal.revenue).toBe(200000);
    expect(report.channels.rd.margin).toBe(20000);
    expect(report.channels.vecinal.margin).toBeNull();
  });

  it('pide el periodo actual y el previo a la misma fuente, en paralelo', async () => {
    await firstValueFrom(service.getDetalleReport({ from: '2026-09-01', to: '2026-09-30', canal: 'all' }));
    const pedidos = mockComercialService.salesByRouteDashboard.mock.calls.map((c: string[]) => c[0]);
    expect(pedidos).toContain('2026-09-01');
    expect(pedidos.length).toBe(2);
  });

  it('debe filtrar adecuadamente por canal cuando se solicita solo RD', async () => {
    const report = await firstValueFrom(
      service.getDetalleReport({
        from: '2026-09-01',
        to: '2026-09-30',
        canal: 'rd',
      })
    );

    expect(report.by_route.length).toBe(1);
    expect(report.by_route.every((r) => r.canal === 'rd')).toBe(true);
    expect(report.kpis.revenue.cur).toBe(100000);
  });
});
