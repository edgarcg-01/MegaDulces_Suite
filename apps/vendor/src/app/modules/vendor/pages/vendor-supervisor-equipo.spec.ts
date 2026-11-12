import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { SellerDayRecap, VecinalVendorDetail, VecinalVendorsResponse, VisitMonitorResponse, VisitMonitorVendor } from '@megadulces/contracts';
import { VendorSupervisorEquipoComponent } from './vendor-supervisor-equipo.component';
import { VendorSupervisorVendedorComponent } from './vendor-supervisor-vendedor.component';
import { SupervisorEquipoService } from '../supervisor-equipo.service';
import { RecuentoDiaService } from '../recuento-dia.service';

/**
 * `[SUP.2]` «Mi equipo» montada con el servidor simulado: abre con el resumen, el que tiene faltas va
 * arriba, y si la venta no se pudo leer se dice (no sale $0).
 */
const conteos = { clientes: 4, visitados: 0, con_pedido: 0, sin_pedido: 0, abiertas: 0, faltas: 0, se_fue_sin_abrir: 0, no_paso: 0, sin_ubicacion: 0, sin_gps: 0, pendientes: 0, lejos: 0 };
const vend = (id: string, name: string, v: Partial<VisitMonitorVendor> = {}): VisitMonitorVendor => ({
  user_id: id, name, routes: ['RUTA 7'], route_source: 'agenda', day_state: 'en_ruta', started_at: '2026-11-06T14:05:00.000Z',
  finished_at: null, closed: false, gps_points: 12, gps_first_at: null, gps_last_at: null, counts: { ...conteos }, rows: [], ...v,
});
const DIA: VisitMonitorResponse = {
  date: '2026-11-06', today: '2026-11-06', radius_m: 80, max_accuracy_m: 50, scope: 'equipo',
  alcance: { tipo_ruta: 'vecinal', etiqueta: 'Rutas vecinales' }, vendor_options: [],
  vendors: [
    vend('u-bien', 'Vendedor Bien', { counts: { ...conteos, visitados: 3, con_pedido: 2, sin_pedido: 1 } }),
    vend('u-falta', 'Vendedor Faltas', {
      counts: { ...conteos, visitados: 1, con_pedido: 1, faltas: 2, no_paso: 2 },
      rows: [
        { customer_id: 'c1', code: 'C-001', name: 'Tienda Uno', on_route: true, has_location: true, status: 'con_pedido', no_sale_reason: null, notes: null,
          visited_at: '2026-11-06T15:00:00.000Z', ended_at: '2026-11-06T15:09:00.000Z', distance_m: 12, far: false, nearest_m: 5 },
        { customer_id: 'c2', code: 'C-002', name: 'Tienda Dos', on_route: true, has_location: true, status: 'no_paso', no_sale_reason: null, notes: null,
          visited_at: null, ended_at: null, distance_m: null, far: false, nearest_m: 900 },
      ],
    }),
  ],
  totals: { ...conteos },
};
const VENTAS: VecinalVendorsResponse = {
  period: { from: '2026-11-06', to: '2026-11-06' } as never, scope: 'propios', route_options: ['RUTA 7'],
  rows: ['u-bien', 'u-falta'].map((id) => ({
    user_id: id, name: id, routes: ['RUTA 7'], days_on_route: 1, day_state: 'en_ruta', route_started_at: null, route_finished_at: null,
    planned_customers: 4, visits: 1, with_order: 1, no_sale_with_reason: 0, no_sale_without_reason: 0, open_visits: 0,
    avg_visit_minutes: 9, orders: 1, ordered_total: 500, charged: 450, charged_unmeasured_reason: null, target: 1000, progress_pct: 45,
    gps_points: 1, gps_last_at: null, first_at: null, last_at: null,
  })),
};

const texto = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, ' ') ?? '';
/** Sin espacios: textContent pega etiquetas vecinas («Empezaron2 de 2»). */
const plano = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, '');

describe('VendorSupervisorEquipoComponent · Mi equipo (SUP.2)', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function montar(ventas: VecinalVendorsResponse | 'falla') {
    const api = {
      dia: vi.fn(() => of(DIA)),
      ventas: vi.fn(() => (ventas === 'falla' ? throwError(() => ({ status: 0 })) : of(ventas))),
      ventasDe: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [VendorSupervisorEquipoComponent],
      providers: [provideRouter([]), { provide: SupervisorEquipoService, useValue: api }],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorSupervisorEquipoComponent);
    fix.detectChanges();
    return { fix, api, el: fix.nativeElement as HTMLElement };
  }

  it('abre con el resumen del día y pone arriba al que tiene faltas', async () => {
    const { el } = await montar(VENTAS);
    const t = texto(el);
    expect(plano(el)).toContain('Empezaron2de2');
    expect(plano(el)).toContain('Clientesvisitados4de8');
    expect(plano(el)).toContain('CobradoenKepler$900');
    const nombres = [...el.querySelectorAll('.eq-card strong')].map((n) => n.textContent?.trim());
    expect(nombres).toEqual(['Vendedor Faltas', 'Vendedor Bien']);
    expect(t).toContain('2 faltas: no pasó con 2');
  });

  it('si la venta no se pudo leer, el equipo se ve igual y el dinero dice «sin medir», no $0', async () => {
    const { el } = await montar('falla');
    const t = texto(el);
    expect(t).toContain('Vendedor Faltas');
    expect(plano(el)).toContain('CobradoenKeplersinmedir');
    // [VTK.16] Sin señal se dice como tal, no como error del servidor.
    expect(t).toContain('Sin señal: revisa tu conexión y vuelve a intentar.');
    expect(t).not.toContain('$0');
  });

  it('«Ayer» vuelve a pedir con la fecha anterior', async () => {
    const { fix, api, el } = await montar(VENTAS);
    const ayer = el.querySelectorAll<HTMLButtonElement>('.eq-dias button')[1];
    ayer.click();
    fix.detectChanges();
    const fecha = (api.dia.mock.calls.at(-1) as unknown as [string])[0];
    expect(fecha < (api.dia.mock.calls[0] as unknown as [string])[0]).toBe(true);
    expect(ayer.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('VendorSupervisorVendedorComponent · un vendedor (SUP.2)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('lista primero la falta y, al abrir un cliente, muestra lo levantado y lo cobrado', async () => {
    const detalle: VecinalVendorDetail = {
      period: { from: '2026-11-06', to: '2026-11-06' } as never, user_id: 'u-falta', name: 'Vendedor Faltas', target: 1000,
      charged: 450, charged_unmeasured_reason: null, ordered_total: 500, total_visits: 1, truncated: false, gps: { total: 0, truncated: false, points: [] },
      visits: [{
        customer_id: 'c1', customer_code: 'C-001', customer_name: 'Tienda Uno', date: '2026-11-06', status: 'con_pedido',
        visited_at: null, ended_at: null, minutes: 9, no_sale_reason: null, notes: null, latitude: null, longitude: null,
        orders: [{ order_id: 'o1', code: 'PD-1', total: 500, created_at: '2026-11-06T15:05:00.000Z',
          lines: [{ product_name: 'PALETA DE PRUEBA', sku: '12345', unit: 'CJA', quantity: 2, line_total: 500 }] }],
        ordered_total: 500, charged: 450,
      }],
    };
    const api = { dia: vi.fn(() => of(DIA)), ventas: vi.fn(), ventasDe: vi.fn(() => of(detalle)) };
    await TestBed.configureTestingModule({
      imports: [VendorSupervisorVendedorComponent],
      providers: [
        provideRouter([]),
        { provide: SupervisorEquipoService, useValue: api },
        { provide: RecuentoDiaService, useValue: { dia: vi.fn(() => of(RECUENTO)) } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ userId: 'u-falta' }), queryParamMap: convertToParamMap({ date: '2026-11-06' }) } } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorSupervisorVendedorComponent);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    expect(api.dia).toHaveBeenCalledWith('2026-11-06', 'u-falta');
    const clientes = [...el.querySelectorAll('.sv-c strong')].map((n) => n.textContent?.trim());
    expect(clientes).toEqual(['Tienda Dos', 'Tienda Uno']);
    expect(texto(el)).toContain('No pasó');
    expect(texto(el)).toContain('9 min');
    el.querySelectorAll<HTMLButtonElement>('.sv-ch')[1].click();
    fix.detectChanges();
    expect(texto(el)).toContain('PALETA DE PRUEBA');
    expect(texto(el)).toContain('2 CJA');
    expect(texto(el)).toContain('Kepler le cobró: $450.00');
  });

  it('[MCP.19] abajo, su recuento del día (el mismo que él ve), en tercera persona y sin repetir visitas ni clientes', async () => {
    const recuento = { dia: vi.fn(() => of(RECUENTO)) };
    await TestBed.configureTestingModule({
      imports: [VendorSupervisorVendedorComponent],
      providers: [
        provideRouter([]),
        { provide: SupervisorEquipoService, useValue: { dia: vi.fn(() => of(DIA)), ventas: vi.fn(), ventasDe: vi.fn(() => throwError(() => ({ status: 404 }))) } },
        { provide: RecuentoDiaService, useValue: recuento },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ userId: 'u-falta' }), queryParamMap: convertToParamMap({ date: '2026-11-06' }) } } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorSupervisorVendedorComponent);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    expect(recuento.dia).toHaveBeenCalledWith('2026-11-06', 'u-falta');
    const caja = el.querySelector<HTMLElement>('app-vendor-recuento-dia');
    expect(caja).not.toBeNull();
    const rd = texto(caja as HTMLElement);
    expect(rd).toContain('Levantó 1 pedido');
    expect(rd).toContain('Surtidos con faltantes');
    expect(rd).toContain('Borradores sin mandar');
    expect(rd).not.toContain('Visitó');
    expect(rd).not.toContain('sin visita');
  });
});

/** `[MCP.19]` Un recuento chico: 1 levantado con faltantes, 1 borrador y un cliente sin visita (que aquí no se repite). */
const RECUENTO: SellerDayRecap = {
  date: '2026-11-06', today: '2026-11-10', user_id: 'u-falta', name: 'Vendedor Faltas',
  orders: { count: 1, total: 500 },
  picking: { completo: 0, con_faltantes: 1, surtiendo: 0, sin_surtir: 0, sin_dato: 0, removed_total: 50, charged: 0, charged_to_confirm: 0, delivered: 0 },
  picking_unmeasured_reason: null,
  visits: { route_customers: 2, routes: ['RUTA 9'], visited: 1, visited_on_route: 1, off_route: 0, with_order: 1, without_order: 0, open: 0, missed: 1, pending: 0,
    closed: true, not_visited: [{ customer_id: 'c2', code: 'C-002', name: 'Tienda Dos', state: 'no_paso' }], no_sale_reasons: [] },
  visits_unmeasured_reason: null,
  pending: { drafts: [{ order_id: 'd1', code: 'PD-9', customer_id: 'c1', customer_name: 'Tienda Uno', total: 80, created_at: '2026-11-06T16:00:00.000Z',
    status: 'draft', pick: 'sin_surtir', removed_total: 0, charge: null, delivered: false, reason: null }], awaiting_approval: [] },
  cancelled: [],
  orders_list: [{ order_id: 'o1', code: 'PD-1', customer_id: 'c1', customer_name: 'Tienda Uno', total: 500, created_at: '2026-11-06T15:05:00.000Z',
    status: 'confirmed', pick: 'con_faltantes', removed_total: 50, charge: null, delivered: false, reason: null }],
};
