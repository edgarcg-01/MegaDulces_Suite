import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { MessageService } from 'primeng/api';
import type { SupervisorBoardResponse, VendorAgendaDay, VendorSummaryResponse } from '@megadulces/contracts';
import { ComercialVendorMenuComponent, agendaByVendor, agendaInfo, dayLabel, mainRouteId } from './comercial-vendor-menu.component';
import { CarteraService, TeamAgendaRow, VendorOption } from '../cartera.service';
import { SupervisorBoardService } from '../supervisor-board.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[MCP.3.10]` «Asignar rutas» como menú de vendedores. Lo que importa:
 * (1) la ruta es la AGENDA semanal (la que usa la app del vendedor), no `vendor_sales_routes`: quien
 *     tiene agenda NO sale «Sin ruta» — fue el defecto que vio David con Paulina;
 * (2) clic → Resumen con la meta contra lo cobrado y sus días, lo no medido declarado;
 * (3) Configurar respeta el permiso de CADA endpoint: ruta = TRADE_ROUTE_PLAN_GESTIONAR (lo tiene
 *     supervisor_ventas), sucursal = COMMERCIAL_CARTERA_GESTIONAR (no lo tiene), meta = can_set_targets;
 * (4) guardar la ruta pone los 7 días y, si se corta, dice cuántos quedaron.
 */
const ROSA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BETO = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const R1 = '1V003 ROSA PÉREZ';
const R2 = '1V010 LIBRE';
const VENDORS: VendorOption[] = [
  { id: ROSA, username: 'rperez', role_name: 'vendedor_ruta', nombre: 'Rosa Pérez' },
  { id: BETO, username: 'beto.r', role_name: 'vendedor_ruta', nombre: null },
];
const semana = (route: string, route_id: string, dias = [1, 2, 3, 4, 5, 6, 7]): VendorAgendaDay[] =>
  dias.map((d) => ({ day_of_week: d, assignment_id: 'as-' + d, route_id, route }));
const AGENDA_EQUIPO: TeamAgendaRow[] = semana(R1, 'rt-1').map((a) => ({
  id: a.assignment_id, user_id: ROSA, route_id: a.route_id, day_of_week: a.day_of_week, route_name: a.route,
}));
const sales = (amount: number | null, why: string | null = null) => ({ amount, tickets: amount == null ? null : 3, unmeasured_reason: why });
const SUMMARY = (o: Partial<VendorSummaryResponse> = {}): VendorSummaryResponse => ({
  user_id: ROSA, name: 'Rosa Pérez', date: '2026-10-22',
  period: { start: '2026-10-17', end: '2026-10-30', day: 6 },
  target: 40000, sales_period: sales(20000), progress_pct: 50, can_set_targets: true,
  routes: [{ route: R1, code: '1V003', warehouse_name: 'Sucursal Centro', customers: 42 }],
  days: [
    { date: '2026-10-22', routes: ['1V003'], customers_total: 42, customers_visited: 30, orders: 12, sales: sales(1500) },
    { date: '2026-10-21', routes: ['1V003'], customers_total: 42, customers_visited: 28, orders: 9, sales: sales(null, 'Kepler no respondió') },
    { date: '2026-10-18', routes: [], customers_total: 0, customers_visited: 0, orders: 0, sales: sales(null, 'Sin ruta ese día') },
  ],
  agenda: semana(R1, 'rt-1'),
  route_options: [{ id: 'rt-1', route: R1, code: '1V003' }, { id: 'rt-2', route: R2, code: '1V010' }],
  freshness: { data_as_of: '2026-10-22T20:59:00Z', status: 'fresh', stale: false, age_human: '1 min', inputs: [] },
  ...o,
});
const BOARD = { vendors: [{ user_id: ROSA, target: null }] } as unknown as SupervisorBoardResponse;

interface Opciones {
  permisos?: Permission[];
  summary?: () => ReturnType<SupervisorBoardService['vendorSummary']>;
  agenda?: () => ReturnType<CarteraService['teamAgenda']>;
  setDay?: (u: string, r: string, d: number) => ReturnType<CarteraService['setAgendaDay']>;
}

async function montar(o: Opciones = {}) {
  const cartera = {
    listVendors: vi.fn(() => of(VENDORS)),
    teamAgenda: vi.fn(o.agenda ?? (() => of(AGENDA_EQUIPO))),
    setAgendaDay: vi.fn(o.setDay ?? (() => of({}))),
    routesWarehouses: vi.fn(() => of({
      warehouses: [{ id: 'wh-c', code: '01', name: 'Sucursal Centro' }, { id: 'wh-n', code: '02', name: 'Sucursal Norte' }],
      routes: [{ route_id: 'rt-1', route: R1, zone: 'Z1', warehouse_id: null, warehouse_name: null, suggested_id: 'wh-n', suggested_name: 'Sucursal Norte' }],
    })),
    setRouteWarehouse: vi.fn(() => of({})),
  };
  const board = {
    board: vi.fn(() => of(BOARD)),
    vendorSummary: vi.fn(o.summary ?? (() => of(SUMMARY()))),
    setTarget: vi.fn((b: { user_id: string; period_start: string; amount: number | null }) => of(b)),
  };
  await TestBed.configureTestingModule({
    imports: [ComercialVendorMenuComponent],
    providers: [
      MessageService,
      { provide: CarteraService, useValue: cartera },
      { provide: SupervisorBoardService, useValue: board },
    ],
  }).compileComponents();
  // Por defecto, lo que supervisor_ventas tiene en prod: ver cartera y gestionar la agenda.
  const permisos = o.permisos ?? [Permission.COMMERCIAL_CARTERA_VER, Permission.TRADE_ROUTE_PLAN_GESTIONAR];
  TestBed.inject(PermissionsService).load(Object.fromEntries(permisos.map((p) => [p, true])), 'supervisor_ventas', 'servidor');
  const fix = TestBed.createComponent(ComercialVendorMenuComponent);
  fix.componentRef.setInput('date', '2026-10-22');
  fix.detectChanges();
  await fix.whenStable();
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const items = () => [...el.querySelectorAll('.vm-item')] as HTMLButtonElement[];
  const elegir = async (i: number) => { items()[i].click(); fix.detectChanges(); await fix.whenStable(); fix.detectChanges(); };
  const configurar = () => { fix.componentInstance.tab.set('configurar'); fix.detectChanges(); };
  return { fix, el, texto, items, elegir, configurar, cartera, board, cmp: fix.componentInstance };
}

describe('ComercialVendorMenuComponent · [MCP.3.10]', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ menú: la ruta sale de su AGENDA (código, sin el nombre); «Sin ruta» sólo de quien no tiene; «Falta meta» sólo si el tablero lo afirma', async () => {
    const { items } = await montar();
    const t = items().map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(t[0]).toBe('beto.r Sin ruta'); // Beto no salió en el tablero: no se afirma que le falte meta.
    expect(t[1]).toContain('Rosa Pérez');
    expect(t[1]).toContain('1V003');
    expect(t[1]).not.toContain('ROSA PÉREZ');
    expect(t[1]).not.toContain('Sin ruta');
    expect(t[1]).toContain('Falta meta');
  });

  it('⛔ si la agenda no se pudo leer, no se dice «Sin ruta» de nadie', async () => {
    const { items } = await montar({ agenda: () => throwError(() => ({ status: 500 })) });
    expect(items().some((b) => b.textContent?.includes('Sin ruta'))).toBe(false);
  });

  it('buscar no distingue acentos y encuentra por ruta', async () => {
    const { fix, cmp, items } = await montar();
    cmp.q.set('rosa perez');
    fix.detectChanges();
    expect(items().length).toBe(1);
    cmp.q.set('1v003');
    fix.detectChanges();
    expect(items().map((b) => b.textContent)).toEqual([expect.stringContaining('Rosa')]);
  });

  it('⭐ clic → Resumen: cobrado contra la meta, avance y sus días; lo no medido dicho, nunca $0', async () => {
    const { elegir, board, texto, el } = await montar();
    await elegir(1);
    expect(board.vendorSummary).toHaveBeenCalledWith(ROSA, '2026-10-22');
    expect(texto()).toMatch(/\$20,000 cobrado de \$40,000/);
    expect(texto()).toContain('50 %');
    expect(texto()).toContain('17–30 oct · día 6 de 14');
    expect(el.querySelector('app-freshness-pill')).not.toBeNull();
    const filas = [...el.querySelectorAll('tbody tr')].map((r) => r.textContent?.replace(/\s+/g, ' ') ?? '');
    expect(filas).toHaveLength(3);
    expect(filas[0]).toContain('30 de 42');
    expect(filas[0]).toContain('$1,500');
    expect(filas[1]).toContain('Sin medir');
    expect(filas[1]).not.toContain('$0');
    expect(filas[2]).toContain('Sin ruta');
    expect(texto()).not.toContain('Va adelantada');
  });

  it('sin meta: lo cobrado y «sin meta capturada» (no 0 %); venta sin medir: el motivo', async () => {
    const { elegir, texto } = await montar({ summary: () => of(SUMMARY({ target: null, progress_pct: null })) });
    await elegir(1);
    expect(texto()).toContain('sin meta capturada');
    expect(texto()).not.toContain('0 %');
    TestBed.resetTestingModule();
    const m = await montar({ summary: () => of(SUMMARY({ sales_period: sales(null, 'Su ruta no tiene vendedor de Kepler') })) });
    await m.elegir(1);
    expect(m.texto()).toContain('Sin medir Su ruta no tiene vendedor de Kepler');
  });

  it('⛔ un error del resumen se dice como error', async () => {
    const { elegir, texto } = await montar({ summary: () => throwError(() => ({ error: { message: 'Esa persona no es de tu equipo' } })) });
    await elegir(1);
    expect(texto()).toContain('Esa persona no es de tu equipo');
  });

  it('⭐ supervisor_ventas: cambia la RUTA (agenda) y la meta; la sucursal la VE y se dice por qué no la cambia', async () => {
    const { elegir, configurar, el, texto, cartera } = await montar();
    await elegir(1);
    configurar();
    expect(texto()).toContain(R1);
    expect(texto()).toContain('toda la semana');
    expect(el.querySelectorAll('p-select').length).toBe(1); // sólo la ruta
    expect(cartera.routesWarehouses).not.toHaveBeenCalled();
    expect(texto()).toContain('Sucursal Centro');
    expect(texto()).toContain('no cambiarla');
    expect(el.querySelector('p-inputnumber')).not.toBeNull();
    expect(texto()).toContain('42'); // clientes a visitar = los de su ruta
  });

  it('sin permiso de agenda: la ruta se ve y no hay selector', async () => {
    const { elegir, configurar, el, texto } = await montar({ permisos: [Permission.COMMERCIAL_CARTERA_VER] });
    await elegir(1);
    configurar();
    expect(el.querySelectorAll('p-select').length).toBe(0);
    expect(texto()).toContain('no puede cambiar la agenda');
  });

  it('⭐ guardar la ruta pone los 7 días con el endpoint de agenda; sin cambio no se manda', async () => {
    const { elegir, cmp, cartera } = await montar();
    await elegir(1);
    expect(cmp.routeDirty()).toBe(false); // ya tiene R1 los 7 días
    cmp.saveRoute();
    expect(cartera.setAgendaDay).not.toHaveBeenCalled();
    cmp.routeDraft.set('rt-2');
    expect(cmp.routeDirty()).toBe(true);
    cmp.saveRoute();
    expect(cartera.setAgendaDay.mock.calls).toEqual([1, 2, 3, 4, 5, 6, 7].map((d) => [ROSA, 'rt-2', d]));
  });

  it('agenda incompleta (le faltan días) cuenta como cambio aunque sea la misma ruta', async () => {
    const { elegir, cmp, configurar, texto } = await montar({ summary: () => of(SUMMARY({ agenda: semana(R1, 'rt-1', [1, 2, 3]) })) });
    await elegir(1);
    configurar();
    expect(texto()).toContain('Lun 1V003 · Mar 1V003 · Mié 1V003 · Jue — ·');
    expect(cmp.routeDirty()).toBe(true);
  });

  it('⛔ si se corta a la mitad, dice cuántos días quedaron (y reintentar es seguro)', async () => {
    let n = 0;
    const { elegir, cmp, fix } = await montar({
      setDay: () => (++n === 4 ? throwError(() => ({ error: { message: 'La ruta no pertenece a la zona del colaborador.' } })) : of({})),
    });
    await elegir(1);
    const toast = TestBed.inject(MessageService);
    const spy = vi.spyOn(toast, 'add');
    cmp.routeDraft.set('rt-2');
    cmp.saveRoute();
    fix.detectChanges();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', detail: expect.stringContaining('3 de 7 días') }));
    expect(cmp.busy()).toBeNull();
  });

  it('⭐ [MCP.3.11] con SÓLO la llave acotada (el supervisor): la sucursal se edita, sin el aviso de candado', async () => {
    const { elegir, configurar, cmp, cartera, el, texto } = await montar({
      permisos: [Permission.COMMERCIAL_CARTERA_VER, Permission.TRADE_ROUTE_PLAN_GESTIONAR, Permission.COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR],
    });
    await elegir(1);
    configurar();
    expect(cmp.canWarehouse()).toBe(true);
    expect(cartera.routesWarehouses).toHaveBeenCalledTimes(1);
    expect(el.querySelectorAll('p-select').length).toBe(2);
    expect(texto()).not.toContain('no cambiarla');
    cmp.saveWarehouse(cmp.whRow(R1)!);
    expect(cartera.setRouteWarehouse).toHaveBeenCalledWith('rt-1', 'wh-n');
  });

  it('con COMMERCIAL_CARTERA_GESTIONAR: confirmar la sucursal sugerida manda la sugerida', async () => {
    const { elegir, configurar, cmp, cartera, el } = await montar({
      permisos: [Permission.COMMERCIAL_CARTERA_VER, Permission.TRADE_ROUTE_PLAN_GESTIONAR, Permission.COMMERCIAL_CARTERA_GESTIONAR],
    });
    await elegir(1);
    configurar();
    expect(el.querySelectorAll('p-select').length).toBe(2);
    const w = cmp.whRow(R1)!;
    expect(cmp.whDirty(w)).toBe(true);
    cmp.saveWarehouse(w);
    expect(cartera.setRouteWarehouse).toHaveBeenCalledWith('rt-1', 'wh-n');
  });

  it('meta: manda el period_start de la catorcena; vacía = quitarla; negativa no se manda; sin cambio no se manda', async () => {
    const { elegir, cmp, board } = await montar();
    await elegir(1);
    cmp.saveTarget();
    expect(board.setTarget).not.toHaveBeenCalled();
    cmp.targetDraft.set(-5);
    cmp.saveTarget();
    expect(board.setTarget).not.toHaveBeenCalled();
    cmp.targetDraft.set(50000);
    cmp.saveTarget();
    expect(board.setTarget).toHaveBeenLastCalledWith({ user_id: ROSA, period_start: '2026-10-17', amount: 50000 });
    cmp.targetDraft.set(null);
    cmp.saveTarget();
    expect(board.setTarget).toHaveBeenLastCalledWith({ user_id: ROSA, period_start: '2026-10-17', amount: null });
  });

  it('llega un vendedor desde el tablero: se abre en su Resumen', async () => {
    const { fix, board, cmp } = await montar();
    cmp.tab.set('configurar');
    fix.componentRef.setInput('initialVendor', ROSA);
    fix.detectChanges();
    expect(cmp.selectedId()).toBe(ROSA);
    expect(cmp.tab()).toBe('resumen');
    expect(board.vendorSummary).toHaveBeenLastCalledWith(ROSA, '2026-10-22');
  });

  it('cambiar la fecha vuelve a pedir el resumen del vendedor elegido', async () => {
    const { fix, elegir, board } = await montar();
    await elegir(1);
    fix.componentRef.setInput('date', '2026-10-20');
    fix.detectChanges();
    expect(board.vendorSummary).toHaveBeenLastCalledWith(ROSA, '2026-10-20');
  });

  it('helpers: agenda por vendedor, lectura de la semana, ruta principal y «mié 21 oct»', () => {
    expect(agendaByVendor(AGENDA_EQUIPO).get(ROSA)).toEqual([R1]);
    expect(agendaByVendor(AGENDA_EQUIPO).has(BETO)).toBe(false);
    expect(agendaInfo(semana(R1, 'rt-1'))).toMatchObject({ route: R1, allWeek: true });
    expect(agendaInfo([]).allWeek).toBe(false);
    const mixta = [...semana(R1, 'rt-1', [1, 2, 3]), ...semana(R2, 'rt-2', [4])];
    expect(agendaInfo(mixta)).toMatchObject({ route: null, allWeek: false });
    expect(mainRouteId(mixta)).toBe('rt-1');
    expect(mainRouteId([])).toBeNull();
    expect(dayLabel('2026-10-21')).toBe('mié 21 oct');
  });
});
