import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import type { VecinalCashiersResponse, VecinalPickersResponse, VecinalVendorDetail, VecinalVendorsResponse } from '@megadulces/contracts';
import { ComercialMonitoreoVecinalComponent } from './comercial-monitoreo-vecinal.component';
import { VecinalMonitorService } from '../vecinal-monitor.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { inicioCatorcena } from '../monitoreo-periodo';
import { todayMx } from '../../../core/utils/mx-date';

/**
 * `[MV.3]` Monitoreo vecinal, montado de verdad (plantilla + signals) con el servidor simulado. Lo que
 * importa es que diga la verdad: lo no medido se dice, el promedio divide entre los días con
 * actividad, y al desplegar a una persona sale su detalle.
 */
const P1 = { from: '2026-11-05', to: '2026-11-05', days: 1 };
const VEND = (): VecinalVendorsResponse => ({
  period: P1, scope: 'todos', route_options: ['1V003 RUTA DEMO'],
  rows: [{
    user_id: 'v1', name: 'Vendedora Prueba', routes: ['1V003 RUTA DEMO'], days_on_route: 1, day_state: 'en_ruta',
    route_started_at: '2026-11-05T14:05:00.000Z', route_finished_at: null, planned_customers: 14, visits: 9, with_order: 6,
    no_sale_with_reason: 2, no_sale_without_reason: 1, open_visits: 1, avg_visit_minutes: 7, orders: 6, ordered_total: 4820,
    charged: null, charged_unmeasured_reason: 'No se pudo leer la venta cobrada en Kepler.', target: 1000, progress_pct: null,
    gps_points: 40, gps_last_at: new Date().toISOString(), first_at: '2026-11-05T14:05:00.000Z', last_at: '2026-11-05T17:42:00.000Z',
  }],
});
const SURT = (): VecinalPickersResponse => ({
  period: P1, scope: 'todos',
  rows: [{ user_id: 's1', name: 'Surtidor Prueba', taken: 7, finished: 6, in_progress: 1, avg_minutes: 16, slowest: { code: 'PD-0236', minutes: 24 },
    with_shortage: 2, substituted: 1, adjusted_by_cashier: 1, first_at: '2026-11-05T14:44:00.000Z', last_at: '2026-11-05T17:50:00.000Z' }],
});
const CAJA = (): VecinalCashiersResponse => ({
  period: P1, scope: 'todos', pending: { count: 2, should_charge: 1340, oldest_finished_at: '2026-11-05T16:00:00.000Z' },
  rows: [{ user_id: 'c1', name: 'Cajera Prueba', reviewed: 5, avg_wait_minutes: 34, avg_review_minutes: null, completed_lines: 2, removed_lines: 0,
    should_charge: 6210.5, delta: 168, first_at: '2026-11-05T15:30:00.000Z', last_at: '2026-11-05T17:58:00.000Z' }],
});
const DET = (): VecinalVendorDetail => ({
  period: P1, user_id: 'v1', name: 'Vendedora Prueba', target: 1000, charged: null, charged_unmeasured_reason: 'sin vista', ordered_total: 640,
  total_visits: 2, truncated: false, gps: { total: 0, truncated: false, points: [] },
  visits: [
    { customer_id: 'a', customer_code: 'C-1', customer_name: 'Tienda Prueba Uno', date: '2026-11-05', status: 'con_pedido',
      visited_at: '2026-11-05T16:02:00.000Z', ended_at: '2026-11-05T16:09:00.000Z', minutes: 7, no_sale_reason: null, notes: null, latitude: null, longitude: null,
      orders: [{ order_id: 'o1', code: 'PD-0245', total: 640, created_at: '2026-11-05T16:05:00.000Z',
        lines: [{ product_name: 'PALETA PAYASO', sku: '30117', unit: 'CJA', quantity: 2, line_total: 456 }] }],
      ordered_total: 640, charged: null },
    { customer_id: 'b', customer_code: 'C-2', customer_name: 'Tienda Prueba Dos', date: '2026-11-05', status: 'sin_pedido',
      visited_at: '2026-11-05T15:31:00.000Z', ended_at: '2026-11-05T15:33:00.000Z', minutes: 2, no_sale_reason: null, notes: null, latitude: null, longitude: null,
      orders: [], ordered_total: 0, charged: null },
  ],
});

describe('ComercialMonitoreoVecinalComponent · Monitoreo vecinal (MV.3)', () => {
  let fix: ComponentFixture<ComercialMonitoreoVecinalComponent>;
  let api: Record<'vendors' | 'vendor' | 'pickers' | 'pickerOrders' | 'cashiers' | 'cashierOrders', ReturnType<typeof vi.fn>>;
  const texto = (): string => (fix.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ') ?? '';

  async function montar(): Promise<void> {
    api = {
      vendors: vi.fn(() => of(VEND())), vendor: vi.fn(() => of(DET())),
      pickers: vi.fn(() => of(SURT())), pickerOrders: vi.fn(() => of({ period: P1, total: 0, truncated: false, data: [] })),
      cashiers: vi.fn(() => of(CAJA())), cashierOrders: vi.fn(() => of({ period: P1, total: 0, truncated: false, data: [] })),
    };
    await TestBed.configureTestingModule({
      imports: [ComercialMonitoreoVecinalComponent],
      providers: [
        { provide: VecinalMonitorService, useValue: api },
        { provide: DataScopeService, useValue: { misSucursales: () => signal(null) } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(ComercialMonitoreoVecinalComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('abre en Resumen con las tres áreas, del día de hoy', async () => {
    await montar();
    const hoy = todayMx();
    expect(api.vendors).toHaveBeenCalledWith(expect.objectContaining({ from: hoy, to: hoy }));
    expect(texto()).toContain('Vendedora Prueba');
    expect(texto()).toContain('Surtidor Prueba');
    expect(texto()).toContain('Cajera Prueba');
    expect(texto()).toContain('2 por revisar');
  });

  it('⭐ lo cobrado que no se pudo medir dice «sin medir», nunca $0', async () => {
    await montar();
    expect(texto()).toContain('sin medir');
    expect(texto()).not.toMatch(/Cobrado.*\$0\.00/);
  });

  it('«Esta catorcena» pide la catorcena del servidor (ancla 17-oct) y ofrece el promedio por día', async () => {
    await montar();
    fix.componentInstance.elegirAtajo('catorcena');
    fix.detectChanges();
    expect(api.vendors).toHaveBeenLastCalledWith(expect.objectContaining({ from: inicioCatorcena(todayMx()) }));
  });

  it('el promedio por día divide los conteos entre los días con actividad', async () => {
    await montar();
    const c = fix.componentInstance;
    c.periodoSel.set({ from: '2026-11-02', to: '2026-11-05' }); // 4 días con actividad
    c.modo.set('promedio');
    expect(c.cuenta(9)).toBe('2.3');
    c.modo.set('total');
    expect(c.cuenta(9)).toBe('9');
  });

  it('⭐ al desplegar a un vendedor: cada cliente, su tiempo, qué le vendió, y la visita sin motivo', async () => {
    await montar();
    fix.componentInstance.irA('vendedores', 'v1');
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    expect(api.vendor).toHaveBeenCalledWith('v1', expect.anything());
    expect(texto()).toContain('Tienda Prueba Uno');
    expect(texto()).toContain('PD-0245');
    expect(texto()).toContain('PALETA PAYASO');
    expect(texto()).toContain('30117');
    expect(texto()).toContain('sin venta · sin motivo');
    expect(texto()).toContain('7 min');
  });

  it('cajeras: el tiempo de revisión se declara «no se registra», y lo que debió cobrar se ve', async () => {
    await montar();
    fix.componentInstance.vista.set('cajeras');
    fix.detectChanges();
    expect(texto()).toContain('no se registra');
    expect(texto()).toContain('6,210.50');
    expect(texto()).toContain('Esperan revisión 2 pedidos');
  });
});
