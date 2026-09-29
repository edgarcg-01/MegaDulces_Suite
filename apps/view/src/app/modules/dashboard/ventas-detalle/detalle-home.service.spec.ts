// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DetalleHomeService, DetalleReport } from './detalle-home.service';
import { environment } from '../../../../environments/environment';

describe('DetalleHomeService', () => {
  let svc: DetalleHomeService;
  let http: HttpTestingController;
  const baseUrl = `${environment.apiUrl}/commercial/analytics/sales-by-route`;

  const mockKeplerReport: DetalleReport = {
    period: { from: '2026-06-01', to: '2026-06-30', days: 30 },
    prev_period: { from: '2026-05-02', to: '2026-05-31' },
    kpis: {
      revenue: { cur: 7010356, prev: 6540200, delta_pct: 7.2 },
      margin: { cur: 890400, prev: 820100, delta_pct: 8.6 },
      margin_pct: { cur: 12.7, prev: 12.5, delta_pct: null },
      tickets: { cur: 10572, prev: 9940, delta_pct: 6.4 },
      avg_ticket: { cur: 663, prev: 658, delta_pct: 0.8 },
      basket: { cur: 6.39, prev: 6.22, delta_pct: 2.7 },
      avg_line: { cur: 103.76, prev: 105.79, delta_pct: -1.9 },
      units_per_ticket: { cur: 15.5, prev: 15.2, delta_pct: 2.0 },
      avg_unit: { cur: 42.64, prev: 43.28, delta_pct: -1.5 },
      customers: { cur: 2103, prev: 2015, delta_pct: 4.4 },
      revenue_per_customer: { cur: 3333, prev: 3246, delta_pct: 2.7 },
    },
    series: [
      { date: '2026-06-01', label: '01 jun', revenue: 245000, margin: 31000, units: 5800, tickets: 370 },
    ],
    channels: {
      rd: {
        canal: 'rd',
        label: 'Venta a bordo (Rutas Directas RD)',
        badge: 'Rutas Directas RD',
        icon: 'pi pi-truck',
        revenue: 5200000,
        share_pct: 74.2,
        tickets: 7800,
        avg_ticket: 667,
        units: 120000,
        margin: 650000,
        margin_pct: 12.5,
        active_routes: 13,
      },
      vecinal: {
        canal: 'vecinal',
        label: 'Preventa en campo (Rutas Vecinales RV)',
        badge: 'Preventa Vecinal',
        icon: 'pi pi-clipboard',
        revenue: 1810356,
        share_pct: 25.8,
        tickets: 2772,
        avg_ticket: 653,
        units: 44405,
        margin: 240400,
        margin_pct: 13.3,
        active_routes: 5,
      },
    },
    by_route: [
      {
        route_code: 'WIN-21',
        route_no: '21',
        name: 'Ruta Directa 21',
        canal: 'rd',
        canal_label: 'Venta a Bordo RD',
        warehouse_code: '01',
        warehouse_name: 'Padre Hidalgo',
        chofer_nombre: 'JOSE DE JESUS ZAVALA VILLALOBOS',
        supervisor_nombre: 'Ángel Alberto Vázquez',
        revenue: 530000,
        revenue_prev: 490000,
        delta_pct: 8.2,
        tickets: 820,
        avg_ticket: 646,
        basket: 6.2,
        units: 12500,
        margin: 66000,
        margin_pct: 12.5,
        customers: 180,
        share_pct: 7.6,
      },
      {
        route_code: 'WIN-1V001',
        route_no: '1V001',
        name: 'Ruta Vecinal 1V001',
        canal: 'vecinal',
        canal_label: 'Preventa Vecinal',
        warehouse_code: '01',
        warehouse_name: 'Padre Hidalgo',
        chofer_nombre: 'MARIANO MARTINEZ PATLAN',
        supervisor_nombre: 'Ángel Alberto Vázquez',
        revenue: 405000,
        revenue_prev: 380000,
        delta_pct: 6.6,
        tickets: 610,
        avg_ticket: 664,
        basket: 6.5,
        units: 9800,
        margin: 54000,
        margin_pct: 13.3,
        customers: 145,
        share_pct: 5.8,
      },
    ],
    by_branch: [
      {
        code: '01',
        name: 'Padre Hidalgo',
        revenue: 3500000,
        tickets: 5200,
        avg_ticket: 673,
        margin: 440000,
        units: 82000,
        routes_count: 8,
      },
    ],
    top_products: [
      {
        sku: '17083',
        nombre: 'ALTOS CAM CHICA COLOR 1KG CLASICA',
        brand: 'BOLSAS DE LOS ALTOS S. DE R.L DE C.V.',
        canal_predominante: 'ambos',
        units: 1854,
        revenue: 110023,
        avg_price: 59.34,
        share_pct: 1.6,
        cum_share_pct: 1.6,
      },
    ],
    customers: [
      {
        cliente_code: '10286',
        cliente_nombre: 'ABARROTES RAMIREZ',
        route_code: 'WIN-1V003',
        tickets: 9,
        revenue: 19811,
        avg_ticket: 2201,
        frecuencia: 'Semanal',
      },
    ],
    routes_catalog: [
      {
        value: 'WIN-21',
        label: 'Padre Hidalgo · Ruta 21',
        warehouse_code: '01',
        warehouse_name: 'Padre Hidalgo',
        route_code: 'WIN-21',
        route_no: '21',
      },
    ],
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        DetalleHomeService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    svc = TestBed.inject(DetalleHomeService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('debe cargar el catálogo de rutas con formato DetalleRouteCatalogItem desde el backend', () => {
    let result: any;
    svc.loadRoutesCatalog().subscribe((r) => (result = r));

    const req = http.expectOne(`${baseUrl}/routes`);
    expect(req.request.method).toBe('GET');
    req.flush([
      {
        value: 'WIN-21',
        label: 'Padre Hidalgo · Ruta 21',
        warehouse_code: '01',
        warehouse_name: 'Padre Hidalgo',
        route_code: 'WIN-21',
        route_no: '21',
      },
    ]);

    expect(result).toBeDefined();
    expect(result.length).toBe(1);
    expect(result[0].value).toBe('WIN-21');
    expect(result[0].label).toBe('Padre Hidalgo · Ruta 21');
  });

  it('debe consultar el endpoint dedicado de Kepler con los parámetros adecuados', () => {
    let report: DetalleReport | undefined;
    svc.getDetalleReport({
      from: '2026-06-01',
      to: '2026-06-30',
      canal: 'rd',
      warehouse_code: '01',
    }).subscribe((r) => (report = r));

    const req = http.expectOne((r) => r.url === `${baseUrl}/detalle-home`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('from')).toBe('2026-06-01');
    expect(req.request.params.get('to')).toBe('2026-06-30');
    expect(req.request.params.get('canal')).toBe('rd');
    expect(req.request.params.get('warehouse_code')).toBe('01');

    req.flush(mockKeplerReport);

    expect(report).toBeDefined();
    expect(report?.kpis).toBeDefined();

    // 1. Volumen: Venta total, Tickets, Unidades/Tk, Partidas/Tk, Clientes reales
    expect(report?.kpis.revenue.cur).toBe(7010356);
    expect(report?.kpis.tickets.cur).toBe(10572);
    expect(report?.kpis.basket.cur).toBe(6.39);
    expect(report?.kpis.units_per_ticket.cur).toBe(15.5);
    expect(report?.kpis.customers.cur).toBe(2103);

    // 2. Precio / Eficiencia: Margen, Margen %, Ticket promedio, Valor/Partida, Valor/Unidad, Venta/Cliente
    expect(report?.kpis.margin.cur).toBe(890400);
    expect(report?.kpis.margin_pct.cur).toBe(12.7);
    expect(report?.kpis.avg_ticket.cur).toBe(663);
    expect(report?.kpis.avg_line.cur).toBe(103.76);
    expect(report?.kpis.avg_unit.cur).toBe(42.64);
    expect(report?.kpis.revenue_per_customer.cur).toBe(3333);

    // 3. Canales segregados RD y Vecinal reales
    expect(report?.channels.rd).toBeDefined();
    expect(report?.channels.vecinal).toBeDefined();
    expect(report?.channels.rd.canal).toBe('rd');
    expect(report?.channels.vecinal.canal).toBe('vecinal');
    expect(report?.channels.rd.revenue).toBe(5200000);
    expect(report?.channels.vecinal.revenue).toBe(1810356);

    // 4. Rutas con nombres reales de choferes de Kepler
    expect(report?.by_route.length).toBe(2);
    expect(report?.by_route[0].chofer_nombre).toBe('JOSE DE JESUS ZAVALA VILLALOBOS');
    expect(report?.by_route[1].chofer_nombre).toBe('MARIANO MARTINEZ PATLAN');

    // 5. Top productos y clientes de Kepler
    expect(report?.top_products.length).toBe(1);
    expect(report?.top_products[0].sku).toBe('17083');
    expect(report?.customers.length).toBe(1);
    expect(report?.customers[0].cliente_nombre).toBe('ABARROTES RAMIREZ');
  });
});
