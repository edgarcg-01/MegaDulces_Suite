// @vitest-environment jsdom
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { DetalleHomeService } from './detalle-home.service';
import { ComercialService } from '../../comercial/comercial.service';
import { of, firstValueFrom } from 'rxjs';

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

  it('debe calcular la matriz de 10 KPIs con deltas y desglosar RD vs Vecinal', async () => {
    const report = await firstValueFrom(
      service.getDetalleReport({
        from: '2026-09-01',
        to: '2026-09-30',
        canal: 'all',
      })
    );

    expect(report).toBeDefined();
    expect(report.kpis).toBeDefined();

    // 1. Volumen: Venta total, Tickets, Unidades/Tk, Partidas/Tk, Clientes
    expect(report.kpis.revenue.cur).toBeGreaterThan(0);
    expect(report.kpis.tickets.cur).toBeGreaterThan(0);
    expect(report.kpis.basket.cur).toBeGreaterThan(0);
    expect(report.kpis.units_per_ticket.cur).toBeGreaterThan(0);
    expect(report.kpis.customers.cur).toBeGreaterThan(0);

    // 2. Precio / Eficiencia: Margen, Margen %, Ticket promedio, Valor/Partida, Valor/Unidad, Venta/Cliente
    expect(report.kpis.margin.cur).toBeGreaterThan(0);
    expect(report.kpis.margin_pct.cur).toBeGreaterThan(0);
    expect(report.kpis.avg_ticket.cur).toBeGreaterThan(0);
    expect(report.kpis.avg_line.cur).toBeGreaterThan(0);
    expect(report.kpis.avg_unit.cur).toBeGreaterThan(0);
    expect(report.kpis.revenue_per_customer.cur).toBeGreaterThan(0);

    // 3. Canales segregados RD y Vecinal
    expect(report.channels.rd).toBeDefined();
    expect(report.channels.vecinal).toBeDefined();
    expect(report.channels.rd.canal).toBe('rd');
    expect(report.channels.vecinal.canal).toBe('vecinal');
  });

  it('debe filtrar adecuadamente por canal cuando se solicita solo RD', async () => {
    const report = await firstValueFrom(
      service.getDetalleReport({
        from: '2026-09-01',
        to: '2026-09-30',
        canal: 'rd',
      })
    );

    expect(report).toBeDefined();
    expect(report.by_route.every((r) => r.canal === 'rd')).toBe(true);
  });
});
