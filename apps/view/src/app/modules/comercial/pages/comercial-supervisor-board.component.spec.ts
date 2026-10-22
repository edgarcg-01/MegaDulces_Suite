import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import type { BoardCustomer, BoardVendor, SetVendorTargetResponse, SupervisorBoardResponse } from '@megadulces/contracts';
import { ComercialSupervisorBoardComponent, periodLabel, routeSpan, sortVendors } from './comercial-supervisor-board.component';
import { ComercialCarteraComponent } from './comercial-cartera.component';
import { SupervisorBoardService } from '../supervisor-board.service';
import { CarteraService } from '../cartera.service';

/**
 * `[MCP.3.9]` Mis vendedores (tablero del supervisor). Lo que importa: (1) Cartera abre en el
 * tablero y las pestañas de asignación siguen; (2) venta null = «Sin medir», nunca $0; (3) la meta
 * sólo se edita con can_set_targets; (4) guardar manda el PUT con el period_start del periodo y
 * revierte si falla; (5) el detalle separa visitados y sin visitar; (6) error ≠ vacío.
 */
const cli = (o: Partial<BoardCustomer>): BoardCustomer => ({
  customer_id: 'c', name: 'Cliente', code: null, visited_at: null, result: null, reason: null, ...o,
});
const vend = (o: Partial<BoardVendor> = {}): BoardVendor => ({
  user_id: 'v1', name: 'Rosa', routes: ['1V003 ROSA PEREZ'], day_state: 'finalizada',
  started_at: '2026-10-22T14:12:00Z', finished_at: '2026-10-22T20:37:00Z',
  customers_total: 3, customers_visited: 2,
  customers: [
    cli({ customer_id: 'a', name: 'ABARROTES LUPITA', visited_at: '2026-10-22T16:05:00Z', result: 'con_pedido' }),
    cli({ customer_id: 'b', name: 'TIENDA DON BETO', visited_at: '2026-10-22T15:30:00Z', result: 'sin_pedido', reason: 'sin_recursos' }),
    cli({ customer_id: 'c', name: 'MISCELANEA CHUY' }),
  ],
  sales_day: { amount: 1500, tickets: 3, unmeasured_reason: null },
  sales_period: { amount: 20000, tickets: 30, unmeasured_reason: null },
  target: 40000, progress_pct: 50, ...o,
});
const RESP = (o: Partial<SupervisorBoardResponse> = {}): SupervisorBoardResponse => {
  const vendors = o.vendors ?? [
    vend(),
    vend({
      user_id: 'v2', name: 'Beto', routes: ['1V010'], day_state: 'en_ruta', finished_at: null,
      sales_day: { amount: null, tickets: null, unmeasured_reason: 'Su ruta no tiene vendedor de Kepler' },
      sales_period: { amount: null, tickets: null, unmeasured_reason: 'Su ruta no tiene vendedor de Kepler' },
      target: null, progress_pct: null, customers_visited: 0, customers: [cli({ customer_id: 'z', name: 'ZAPATA' })], customers_total: 1,
    }),
  ];
  return {
    date: '2026-10-22', period: { start: '2026-10-17', end: '2026-10-30', day: 6 }, scope: 'vecinal',
    scope_label: 'Rutas vecinales', can_set_targets: true, vendors,
    totals: { vendors: vendors.length, customers_total: 4, customers_visited: 2, sales_day: 1500, sales_period: 20000, target: 40000 },
    generated_at: '2026-10-22T21:00:00Z',
    freshness: { data_as_of: '2026-10-22T20:59:00Z', status: 'fresh', stale: false, age_human: '1 min', inputs: [] },
    ...o,
  };
};

async function montar(resp: () => ReturnType<SupervisorBoardService['board']>, put?: () => ReturnType<SupervisorBoardService['setTarget']>) {
  const svc = {
    board: vi.fn(resp),
    setTarget: vi.fn(put ?? (() => of({ user_id: 'v1', period_start: '2026-10-17', amount: 50000 } as SetVendorTargetResponse))),
  };
  await TestBed.configureTestingModule({
    imports: [ComercialSupervisorBoardComponent],
    providers: [{ provide: SupervisorBoardService, useValue: svc }],
  }).compileComponents();
  const fix = TestBed.createComponent(ComercialSupervisorBoardComponent);
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  return { fix, el, texto, svc, cmp: fix.componentInstance };
}

describe('ComercialSupervisorBoardComponent · [MCP.3.9]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ un error se dice como error, nunca como «nadie tiene ruta»', async () => {
    const { texto } = await montar(() => throwError(() => ({ error: { message: 'Falló Kepler' } })));
    expect(texto()).toContain('Falló Kepler');
    expect(texto()).not.toContain('Nadie de tu equipo');
  });

  it('vacío real con el alcance: «Nadie de tu equipo tiene ruta vecinal…»', async () => {
    const { texto } = await montar(() => of(RESP({ vendors: [] })));
    expect(texto()).toMatch(/Nadie de tu equipo tiene ruta vecinal (hoy|ese día)/);
  });

  it('encabezado: alcance, catorcena y día del periodo', async () => {
    const { texto } = await montar(() => of(RESP()));
    expect(texto()).toContain('Rutas vecinales');
    expect(texto()).toContain('Catorcena 17–30 oct');
    expect(texto()).toContain('día 6 de 14');
  });

  it('⭐ fila por vendedor: código de ruta sin el nombre, inicio–fin, «En ruta desde», visitados', async () => {
    const { texto } = await montar(() => of(RESP()));
    expect(texto()).toContain('1V003');
    expect(texto()).not.toContain('ROSA PEREZ');
    expect(texto()).toContain('8:12 – 14:37');
    expect(texto()).toContain('En ruta desde 8:12');
    expect(texto()).toContain('2 de 3');
  });

  it('⛔ venta null se pinta «Sin medir» con su motivo, nunca $0', async () => {
    const { el } = await montar(() => of(RESP()));
    const sm = el.querySelectorAll('.sb-unmeasured');
    expect(sm.length).toBe(2);
    expect(sm[0].getAttribute('title')).toBe('Su ruta no tiene vendedor de Kepler');
    const fila = [...el.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('Beto'))!;
    expect(fila.textContent).toContain('Sin medir');
    expect(fila.textContent).not.toContain('$0');
  });

  it('⛔ totales: venta del equipo null → «Sin medir» con motivo; parcial si falta un vendedor', async () => {
    const { cmp } = await montar(() => of(RESP()));
    const hoy = cmp.kpis().find((k) => k.label === 'Venta cobrada hoy')!;
    expect(hoy.state).toBe('parcial');
    expect(hoy.stateNote).toContain('1 de 2 vendedores sin medir');
    const cat = cmp.kpis().find((k) => k.label === 'Venta de la catorcena')!;
    expect(cat.sub).toContain('avance 50 %');
    expect(cat.sub).toContain('1 de 2 con meta');
    cmp.data.set(RESP({ totals: { vendors: 2, customers_total: 4, customers_visited: 2, sales_day: null, sales_period: null, target: null } }));
    const nulo = cmp.kpis().find((k) => k.label === 'Venta cobrada hoy')!;
    expect(nulo.state).toBe('no_medido');
    expect(nulo.value).toBe('Sin medir');
    expect(nulo.stateNote).toContain('Su ruta no tiene vendedor de Kepler');
  });

  it('meta editable SÓLO con can_set_targets; sin permiso se muestra el valor o «Sin meta»', async () => {
    const { el, cmp, fix, texto } = await montar(() => of(RESP()));
    expect(el.querySelectorAll('p-inputnumber').length).toBe(2);
    cmp.data.set(RESP({ can_set_targets: false }));
    fix.detectChanges();
    expect(el.querySelectorAll('p-inputnumber').length).toBe(0);
    expect(texto()).toContain('$40,000');
    expect(texto()).toContain('Sin meta');
  });

  it('sin permiso y sin meta para nadie: no se pinta ni Meta ni Avance (columna vacía)', async () => {
    const vs = [vend({ target: null, progress_pct: null })];
    const { el } = await montar(() => of(RESP({ can_set_targets: false, vendors: vs })));
    const ths = [...el.querySelectorAll('thead th')].map((t) => t.textContent?.trim());
    expect(ths).toEqual(['Vendedor', 'Ruta', 'Visitados', 'Venta hoy', 'Venta catorcena']);
  });

  it('⭐ guardar manda el PUT con el period_start del periodo y queda la meta nueva', async () => {
    const { cmp, svc } = await montar(() => of(RESP()));
    const v = cmp.data()!.vendors[0];
    cmp.setDraft(v.user_id, 50000);
    expect(cmp.dirty(v)).toBe(true);
    cmp.saveTarget(v);
    expect(svc.setTarget).toHaveBeenCalledWith({ user_id: 'v1', period_start: '2026-10-17', amount: 50000 });
    const after = cmp.data()!.vendors[0];
    expect(after.target).toBe(50000);
    expect(after.progress_pct).toBe(40);
    expect(cmp.saving()).toBeNull();
  });

  it('⛔ si el PUT falla, la meta vuelve a la anterior (optimista con rollback)', async () => {
    const res$ = new Subject<SetVendorTargetResponse>();
    const { cmp } = await montar(() => of(RESP()), () => res$.asObservable());
    const v = cmp.data()!.vendors[0];
    cmp.setDraft(v.user_id, 90000);
    cmp.saveTarget(v);
    // Optimista: ya se ve la nueva mientras el servidor contesta.
    expect(cmp.data()!.vendors[0].target).toBe(90000);
    expect(cmp.saving()).toBe('v1');
    // Doble clic del pánico: no manda otro PUT.
    cmp.saveTarget(cmp.data()!.vendors[0]);
    res$.error({ error: { message: 'Sin permiso' } });
    expect(cmp.data()!.vendors[0].target).toBe(40000);
    expect(cmp.data()!.vendors[0].progress_pct).toBe(50);
    expect(cmp.saving()).toBeNull();
  });

  it('meta negativa no se manda; sin permiso no se manda', async () => {
    const { cmp, svc } = await montar(() => of(RESP()));
    const v = cmp.data()!.vendors[0];
    cmp.setDraft(v.user_id, -5);
    cmp.saveTarget(v);
    expect(svc.setTarget).not.toHaveBeenCalled();
    cmp.data.set(RESP({ can_set_targets: false }));
    cmp.setDraft('v1', 100);
    cmp.saveTarget(cmp.data()!.vendors[0]);
    expect(svc.setTarget).not.toHaveBeenCalled();
  });

  it('⭐ el detalle separa «Visitados» (por hora, con resultado y motivo) de «Sin visitar»', async () => {
    const { cmp, fix, el, texto } = await montar(() => of(RESP()));
    expect(el.querySelector('#sb-detail')).toBeNull();
    cmp.select('v1');
    fix.detectChanges();
    const det = el.querySelector('#sb-detail')!;
    expect(det).not.toBeNull();
    expect(texto()).toContain('Visitados (2)');
    expect(texto()).toContain('Sin visitar (1)');
    const visitados = [...det.querySelectorAll('ul')[0].querySelectorAll('.sb-cname')].map((x) => x.textContent?.trim());
    expect(visitados).toEqual(['TIENDA DON BETO', 'ABARROTES LUPITA']);
    expect(det.querySelectorAll('ul')[1].textContent).toContain('MISCELANEA CHUY');
    expect(det.textContent).toContain('No tiene dinero');
    expect(det.textContent).toContain('Con pedido');
  });

  it('orden por avance: el más atrasado primero y los sin meta al final', () => {
    const a = vend({ user_id: 'a', name: 'A', progress_pct: 80 });
    const b = vend({ user_id: 'b', name: 'B', progress_pct: null });
    const c = vend({ user_id: 'c', name: 'C', progress_pct: 10 });
    expect(sortVendors([a, b, c], 'avance').map((v) => v.user_id)).toEqual(['c', 'a', 'b']);
    const d = vend({ user_id: 'd', name: 'D', sales_period: { amount: null, tickets: null, unmeasured_reason: 'x' } });
    const e = vend({ user_id: 'e', name: 'E', sales_period: { amount: 5, tickets: 1, unmeasured_reason: null } });
    expect(sortVendors([d, e, a], 'venta').map((v) => v.user_id)).toEqual(['a', 'e', 'd']);
  });

  it('helpers: periodo que cruza de mes y «Sin iniciar»', () => {
    expect(periodLabel('2026-10-31', '2026-11-13')).toBe('31 oct – 13 nov');
    expect(routeSpan(vend({ day_state: 'sin_iniciar', started_at: null, finished_at: null }))).toBe('Sin iniciar');
  });

  it('cambiar la fecha vuelve a pedir el tablero de ese día', async () => {
    const { cmp, svc } = await montar(() => of(RESP()));
    cmp.setDate(new Date('2026-10-20T18:00:00Z'));
    expect(svc.board).toHaveBeenLastCalledWith('2026-10-20');
  });
});

describe('ComercialCarteraComponent · pestañas [MCP.3.9]', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function montarCartera() {
    const cartera = {
      listVendors: vi.fn(() => of([])), listSalesRoutes: vi.fn(() => of([])),
      routesWarehouses: vi.fn(() => of({ warehouses: [], routes: [] })),
    };
    const board = { board: vi.fn(() => of(RESP())), setTarget: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ComercialCarteraComponent],
      providers: [
        provideRouter([]),
        { provide: CarteraService, useValue: cartera },
        { provide: SupervisorBoardService, useValue: board },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(ComercialCarteraComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    return { fix, el, cartera, board, cmp: fix.componentInstance };
  }

  it('⭐ abre en «Mis vendedores»; «Visitas del día» ya no es pestaña; las de asignación siguen', async () => {
    const { el, cmp, cartera, board } = await montarCartera();
    expect(cmp.view()).toBe('tablero');
    expect(el.querySelector('app-comercial-supervisor-board')).not.toBeNull();
    expect(board.board).toHaveBeenCalled();
    const tabs = [...el.querySelectorAll('.ca-tab')].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Mis vendedores', 'Asignar rutas', 'Sucursal por ruta']);
    // La asignación no se pide hasta abrir su pestaña.
    expect(cartera.listSalesRoutes).not.toHaveBeenCalled();
    cmp.showVendedores();
    expect(cartera.listSalesRoutes).toHaveBeenCalledTimes(1);
    cmp.showSucursales();
    expect(cartera.routesWarehouses).toHaveBeenCalledTimes(1);
  });
});
