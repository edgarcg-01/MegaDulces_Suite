import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import type { BoardVendor, SupervisorBoardResponse } from '@megadulces/contracts';
import { ComercialSupervisorBoardComponent, money, periodLabel, routeSpan, sortVendors } from './comercial-supervisor-board.component';
import { ComercialCarteraComponent } from './comercial-cartera.component';
import { SupervisorBoardService } from '../supervisor-board.service';
import { CarteraService } from '../cartera.service';

/**
 * `[MCP.3.9]`/`[MCP.3.10]` Mis vendedores (tablero del supervisor), ya reducido a pedido de David:
 * (1) sólo Vendedor · Ruta · Visitados · Venta hoy — sin totales, meta, avance ni detalle;
 * (2) venta null = «Sin medir», nunca $0; (3) error ≠ vacío; (4) la fecha y el orden vienen de la
 * barra de Cartera y la respuesta vieja no tapa a la nueva; (5) Cartera: dos pestañas y una barra.
 */
const vend = (o: Partial<BoardVendor> = {}): BoardVendor => ({
  user_id: 'v1', name: 'Rosa', routes: ['1V003 ROSA PEREZ'], day_state: 'finalizada',
  started_at: '2026-10-22T14:12:00Z', finished_at: '2026-10-22T20:37:00Z',
  customers_total: 3, customers_visited: 2, customers: [],
  sales_day: { amount: 1500, tickets: 3, unmeasured_reason: null },
  sales_period: { amount: 20000, tickets: 30, unmeasured_reason: null },
  target: 40000, progress_pct: 50, ...o,
});
const SIN_KEPLER = 'Su ruta no tiene vendedor de Kepler';
const RESP = (o: Partial<SupervisorBoardResponse> = {}): SupervisorBoardResponse => {
  const vendors = o.vendors ?? [
    vend(),
    vend({
      user_id: 'v2', name: 'Beto', routes: ['1V010'], day_state: 'en_ruta', finished_at: null,
      sales_day: { amount: null, tickets: null, unmeasured_reason: SIN_KEPLER },
      sales_period: { amount: null, tickets: null, unmeasured_reason: SIN_KEPLER },
      target: null, progress_pct: null, customers_visited: 0, customers_total: 1,
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

async function montar(resp: (date: string) => ReturnType<SupervisorBoardService['board']>) {
  const svc = { board: vi.fn(resp) };
  await TestBed.configureTestingModule({
    imports: [ComercialSupervisorBoardComponent],
    providers: [{ provide: SupervisorBoardService, useValue: svc }],
  }).compileComponents();
  const fix = TestBed.createComponent(ComercialSupervisorBoardComponent);
  fix.componentRef.setInput('date', '2026-10-22');
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const headers = () => [...el.querySelectorAll('th')].map((t) => t.textContent?.trim());
  return { fix, el, texto, headers, svc, cmp: fix.componentInstance };
}

describe('ComercialSupervisorBoardComponent · [MCP.3.10]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⛔ un error se dice como error, nunca como «nadie tiene ruta»', async () => {
    const { texto } = await montar(() => throwError(() => ({ error: { message: 'Falló Kepler' } })));
    expect(texto()).toContain('Falló Kepler');
    expect(texto()).not.toContain('Nadie de tu equipo');
  });

  it('vacío real con el alcance: «Nadie de tu equipo tiene ruta vecinal…»', async () => {
    const { texto } = await montar(() => of(RESP({ vendors: [] })));
    expect(texto()).toContain('Nadie de tu equipo tiene ruta vecinal');
  });

  it('⭐ sólo cuatro columnas: sin meta, avance, venta de la catorcena, totales ni detalle', async () => {
    const { el, texto, headers } = await montar(() => of(RESP()));
    expect(headers()).toEqual(['Vendedor', 'Ruta de hoy', 'Visitados', 'Venta hoy']);
    expect(el.querySelector('app-metric-strip')).toBeNull();
    expect(el.querySelector('app-context-help')).toBeNull();
    expect(el.querySelector('aside')).toBeNull();
    expect(el.querySelector('p-inputnumber')).toBeNull();
    expect(texto()).not.toContain('Catorcena');
  });

  it('⛔ la base de tabla va en la <table> de adentro (en el <p-table> no aplica: salía sin padding ni encabezado)', async () => {
    const { el } = await montar(() => of(RESP()));
    expect(el.querySelector('table.surf-table--plain')).not.toBeNull();
    expect(el.querySelector('.sb-panel')).not.toBeNull();
    expect(el.querySelectorAll('p-tag').length).toBe(2);
  });

  it('⭐ el nombre es un botón (teclado): avisa qué vendedor abrir', async () => {
    const { el, cmp, fix } = await montar(() => of(RESP()));
    const pedidos: string[] = [];
    cmp.openVendor.subscribe((id) => pedidos.push(id));
    (el.querySelectorAll('button.sb-name')[1] as HTMLButtonElement).click();
    fix.detectChanges();
    expect(pedidos).toEqual(['v2']);
  });

  it('fila por vendedor: código de ruta sin el nombre, inicio–fin, «En ruta desde», visitados', async () => {
    const { el } = await montar(() => of(RESP()));
    const filas = [...el.querySelectorAll('tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '');
    expect(filas[0]).toContain('Rosa');
    expect(filas[0]).toContain('1V003');
    expect(filas[0]).not.toContain('ROSA PEREZ');
    expect(filas[0]).toContain('Terminó');
    expect(filas[0]).toMatch(/8:12 – 14:37/);
    expect(filas[0]).toContain('67 %');
    expect(filas[0]).toContain('2 de 3');
    expect(filas[1]).toContain('En ruta');
    expect(filas[1]).toMatch(/desde 8:12/);
  });

  it('⛔ venta null se pinta «Sin medir» con su motivo, nunca $0', async () => {
    const { el } = await montar(() => of(RESP()));
    const beto = [...el.querySelectorAll('tbody tr')][1];
    const sm = beto.querySelector('.sb-unmeasured') as HTMLElement;
    expect(sm.textContent?.trim()).toBe('Sin medir');
    expect(sm.getAttribute('title')).toBe(SIN_KEPLER);
    expect(beto.textContent).not.toContain('$0');
  });

  it('si la venta no se midió para NADIE (Ruta directa), la columna «Venta hoy» no se pinta', async () => {
    const nadie = { amount: null, tickets: null, unmeasured_reason: 'Ruta directa' };
    const { headers } = await montar(() => of(RESP({ scope: 'directa', vendors: [vend({ sales_day: nadie })] })));
    expect(headers()).toEqual(['Vendedor', 'Ruta de hoy', 'Visitados']);
  });

  it('la fecha viene de la barra: cambiarla vuelve a pedir el tablero de ese día', async () => {
    const { fix, svc } = await montar(() => of(RESP()));
    expect(svc.board).toHaveBeenLastCalledWith('2026-10-22');
    fix.componentRef.setInput('date', '2026-10-20');
    fix.detectChanges();
    expect(svc.board).toHaveBeenLastCalledWith('2026-10-20');
  });

  it('⛔ la respuesta vieja no tapa a la nueva', async () => {
    const lenta = new Subject<SupervisorBoardResponse>();
    const { fix, cmp } = await montar((d) => (d === '2026-10-22' ? lenta : of(RESP({ date: '2026-10-20' }))));
    fix.componentRef.setInput('date', '2026-10-20');
    fix.detectChanges();
    lenta.next(RESP({ date: '2026-10-22' }));
    expect(cmp.data()?.date).toBe('2026-10-20');
  });

  it('orden: Venta = la de HOY, mayor primero y la sin medir al final; Nombre alfabético', () => {
    const sinMedir = { amount: null, tickets: null, unmeasured_reason: 'x' };
    const a = vend({ user_id: 'a', name: 'Ana', sales_day: { amount: 100, tickets: 1, unmeasured_reason: null } });
    const b = vend({ user_id: 'b', name: 'Beto', sales_day: sinMedir });
    const c = vend({ user_id: 'c', name: 'Carla', sales_day: { amount: 900, tickets: 1, unmeasured_reason: null } });
    const z = vend({ user_id: 'z', name: 'Zoe', sales_day: { amount: 0, tickets: 0, unmeasured_reason: null } });
    expect(sortVendors([a, b, c, z], 'venta').map((v) => v.user_id)).toEqual(['c', 'a', 'z', 'b']);
    expect(sortVendors([c, b, a], 'nombre').map((v) => v.user_id)).toEqual(['a', 'b', 'c']);
  });

  it('helpers: periodo que cruza de mes, «Sin iniciar», dinero del texto de Postgres y vacío = —', () => {
    expect(periodLabel('2026-10-17', '2026-10-30')).toBe('17–30 oct');
    expect(periodLabel('2026-10-31', '2026-11-13')).toBe('31 oct – 13 nov');
    expect(routeSpan(vend({ day_state: 'sin_iniciar', started_at: null, finished_at: null }))).toBe('Sin iniciar');
    expect(money('1500.50')).toMatch(/1,501|1,500/);
    expect(money(null)).toBe('—');
    expect(money('')).toBe('—');
  });
});

describe('ComercialCarteraComponent · una barra, dos pestañas [MCP.3.10]', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function montarCartera(vista: string | null = null) {
    const cartera = {
      listVendors: vi.fn(() => of([])), teamAgenda: vi.fn(() => of([])),
      routesWarehouses: vi.fn(() => of({ warehouses: [], routes: [] })),
    };
    const board = { board: vi.fn(() => of(RESP())), vendorSummary: vi.fn(), setTarget: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [ComercialCarteraComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(vista ? { vista } : {}) } } },
        { provide: CarteraService, useValue: cartera },
        { provide: SupervisorBoardService, useValue: board },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(ComercialCarteraComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const opciones = () => [...el.querySelectorAll('.ca-bar app-segmented')].map((s) =>
      [...s.querySelectorAll('[role=radio]')].map((b) => b.textContent?.trim()));
    return { fix, el, cartera, board, opciones, cmp: fix.componentInstance };
  }

  it('⭐ abre en «Mis vendedores»: pestañas y «Ordenar» en la MISMA barra, y la frescura «Venta Kepler»', async () => {
    const { el, cmp, board, cartera, opciones } = await montarCartera();
    expect(cmp.view()).toBe('tablero');
    expect(el.querySelector('app-comercial-supervisor-board')).not.toBeNull();
    expect(board.board).toHaveBeenCalled();
    expect(opciones()).toEqual([['Mis vendedores', 'Asignar rutas'], ['Venta', 'Nombre']]);
    expect(el.textContent).not.toContain('Sucursal por ruta');
    expect(el.querySelector('.ca-bar app-freshness-pill')).not.toBeNull();
    expect(cmp.boardFreshness()?.status).toBe('fresh');
    // La asignación no se pide hasta abrir su pestaña.
    expect(cartera.listVendors).not.toHaveBeenCalled();
  });

  it('«Asignar rutas» monta el menú de vendedores y oculta «Ordenar»', async () => {
    const { fix, el, cmp, cartera, opciones } = await montarCartera();
    cmp.setView('vendedores');
    fix.detectChanges();
    expect(el.querySelector('app-comercial-vendor-menu')).not.toBeNull();
    expect(cartera.listVendors).toHaveBeenCalledTimes(1);
    expect(opciones()).toEqual([['Mis vendedores', 'Asignar rutas']]);
  });

  it('⭐ del tablero al Resumen: clic en un vendedor abre «Asignar rutas» en ese vendedor', async () => {
    const { fix, el, cmp, board } = await montarCartera();
    board.vendorSummary.mockReturnValue(of({ ...RESP(), user_id: 'v1' }) as never);
    cmp.openVendor('v1');
    fix.detectChanges();
    await fix.whenStable();
    expect(cmp.view()).toBe('vendedores');
    expect(el.querySelector('app-comercial-vendor-menu')).not.toBeNull();
    expect(board.vendorSummary).toHaveBeenCalledWith('v1', cmp.date());
  });

  it('enlaces viejos: ?vista=sucursales (ya no existe) abre «Asignar rutas»', async () => {
    const { cmp } = await montarCartera('sucursales');
    expect(cmp.view()).toBe('vendedores');
  });
});
