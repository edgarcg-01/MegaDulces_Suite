import { AlertsSocketService } from '../../dashboard/command-center/alerts-socket.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import type { RouteBatchInboxResponse, RouteBatchRow } from '@megadulces/contracts';
import { AlmacenRutasHoyComponent } from './almacen-rutas-hoy.component';
import { PresalePickingService } from '../presale-picking.service';
import { AuthService } from '../../../core/services/auth.service';

/** Una ruta del día como la manda GET /warehouse/presale-picking/routes. */
const R = (p: Partial<RouteBatchRow> = {}): RouteBatchRow => ({
  route_day_id: 'rd-lista', kind: 'ruta', seller_name: 'Paulina Placencia', work_date: '2026-10-21', state: 'lista',
  started_at: '2026-10-21T14:00:00.000Z', finished_at: '2026-10-21T20:10:00.000Z', orders: 4, products: 18,
  pick_started: null, pick_finished: null, ...p,
});

const BANDEJA = (data: RouteBatchRow[]): RouteBatchInboxResponse => ({ today: '2026-10-21', scope: 'propios', data });

/**
 * `[MCP.3.6]` Las tarjetas de las rutas de hoy en Surtir › Sucursal, montadas de verdad con el
 * servidor simulado: qué dice cada estado, qué botón ofrece (y cuándo NO), y que un error se dice
 * como error y no como «no hay rutas».
 */
describe('AlmacenRutasHoyComponent · rutas de hoy (MCP.3.6)', () => {
  let fix: ComponentFixture<AlmacenRutasHoyComponent>;
  let api: { routes: ReturnType<typeof vi.fn>; routeStart: ReturnType<typeof vi.fn> };
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const tarjeta = (estado: string): HTMLElement | null => el().querySelector(`[data-estado="${estado}"]`);
  const botones = (n: HTMLElement | null): string[] =>
    Array.from(n?.querySelectorAll('button') ?? []).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

  async function montar(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AlmacenRutasHoyComponent],
      providers: [
        provideRouter([]),
        { provide: PresalePickingService, useValue: api },
        { provide: AuthService, useValue: { user: () => ({ sub: 'yo' }) } },
        { provide: AlertsSocketService, useValue: { connect: () => undefined, alert$: new Subject<{ type: string }>() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenRutasHoyComponent);
    fix.detectChanges();
  }

  beforeEach(() => {
    api = {
      routes: vi.fn(() => of(BANDEJA([
        R({ route_day_id: 'rd-hecha', seller_name: 'Juan Pérez', state: 'surtida',
            pick_finished: { user_id: 'yo', name: 'Ángel Cisneros', at: '2026-10-21T16:40:00.000Z' } }),
        R({ route_day_id: 'rd-ruta', seller_name: 'Rosa Díaz', state: 'en_ruta', finished_at: null, started_at: '2026-10-21T15:05:00.000Z' }),
        R(),
        R({ route_day_id: 'rd-otro', seller_name: 'Luis Gómez', state: 'surtiendo',
            pick_started: { user_id: 'otro', name: 'Félix Herrera', at: '2026-10-21T17:00:00.000Z' } }),
      ]))),
      routeStart: vi.fn(() => of(R({ state: 'surtiendo' }))),
    };
  });

  afterEach(() => TestBed.resetTestingModule());

  it('[MCP.3.13] la tarjeta dice qué otra sucursal surte su parte de la ruta; sin partes, nada', async () => {
    api.routes = vi.fn(() => of(BANDEJA([
      R({ group_other_warehouses: ['PH'] }),
      R({ route_day_id: 'rd-otro', seller_name: 'Luis Gómez', state: 'surtiendo', group_other_warehouses: [],
          pick_started: { user_id: 'otro', name: 'Félix Herrera', at: '2026-10-21T17:00:00.000Z' } }),
    ])));
    await montar();
    expect(tarjeta('lista')!.textContent!.replace(/\s+/g, ' ')).toContain('Pedidos agrupados · también surte PH');
    // Prueba negativa: una ruta sin partes en otra sucursal no lleva rótulo.
    expect(tarjeta('surtiendo')!.querySelector('.rh-parte')).toBeNull();
  });

  it('⭐ lista: tarjeta destacada con la hora en que terminó, pedidos, productos y «Empezar a recolectar»', async () => {
    await montar();
    const t = tarjeta('lista')!;
    const s = t.textContent!.replace(/\s+/g, ' ');
    expect(s).toContain('Ruta de Paulina Placencia');
    expect(s).toContain('Terminó a las 14:10'); // 20:10 UTC = 14:10 en México
    expect(s).toContain('4 pedidos · 18 productos');
    expect(botones(t)).toEqual(['Empezar a recolectar']);
    expect(t.classList).toContain('rh-card-lista');
  });

  it('[MCP.3.6] lo levantado después de cerrar la ruta es OTRO pedido global: «Fuera de la ruta», listo para recolectar', async () => {
    api.routes = vi.fn(() => of(BANDEJA([
      R({ route_day_id: 'rd-fuera', kind: 'fuera_de_ruta', finished_at: null, orders: 4, products: 9 }),
    ])));
    await montar();
    const t = tarjeta('lista')!;
    const s = t.textContent!.replace(/\s+/g, ' ');
    expect(s).toContain('Fuera de la ruta · Paulina Placencia');
    expect(s).toContain('Levantado después de cerrar su ruta');
    expect(s).toContain('4 pedidos · 9 productos');
    expect(botones(t)).toEqual(['Empezar a recolectar']);
  });

  it('la que hay que recolectar va primero, aunque el servidor la mande después', async () => {
    await montar();
    const orden = Array.from(el().querySelectorAll('[data-estado]')).map((n) => n.getAttribute('data-estado'));
    expect(orden).toEqual(['lista', 'surtiendo', 'en_ruta', 'surtida']);
  });

  it('«Empezar a recolectar» arranca la ruta y entra a Recolectar', async () => {
    await montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    (tarjeta('lista')!.querySelector('button') as HTMLButtonElement).click();
    expect(api.routeStart).toHaveBeenCalledWith('rd-lista');
    expect(TestBed.inject(Router).serializeUrl(nav.mock.calls[0][0] as UrlTree)).toBe('/almacen/surtir/ruta/rd-lista');
  });

  it('si no se pudo empezar (otro la tomó), lo dice, no entra y refresca la lista', async () => {
    api.routeStart = vi.fn(() => throwError(() => ({ status: 409, error: { message: 'Ya la está recolectando Félix Herrera.' } })));
    await montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    (tarjeta('lista')!.querySelector('button') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(nav).not.toHaveBeenCalled();
    expect(texto()).toContain('Ya la está recolectando Félix Herrera.');
    expect(api.routes).toHaveBeenCalledTimes(2);
  });

  it('⭐ surtiendo por OTRA persona: dice quién y desde cuándo, y no ofrece entrar (prueba negativa)', async () => {
    await montar();
    const t = tarjeta('surtiendo')!;
    expect(t.textContent).toContain('La está recolectando Félix Herrera desde las 11:00.');
    expect(botones(t)).toEqual([]);
  });

  it('surtiendo por MÍ: «Seguir recolectando» entra sin volver a arrancarla', async () => {
    api.routes = vi.fn(() => of(BANDEJA([R({ state: 'surtiendo', pick_started: { user_id: 'yo', name: 'Yo', at: '2026-10-21T17:00:00.000Z' } })])));
    await montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const t = tarjeta('surtiendo')!;
    expect(botones(t)).toEqual(['Seguir recolectando']);
    (t.querySelector('button') as HTMLButtonElement).click();
    expect(api.routeStart).not.toHaveBeenCalled();
    expect(TestBed.inject(Router).serializeUrl(nav.mock.calls[0][0] as UrlTree)).toBe('/almacen/surtir/ruta/rd-lista');
  });

  it('en ruta: tarjeta simple, desde qué hora, y sin botón', async () => {
    await montar();
    const t = tarjeta('en_ruta')!;
    expect(t.textContent!.replace(/\s+/g, ' ')).toContain('Ruta de Rosa Díaz');
    expect(t.textContent!.replace(/\s+/g, ' ')).toContain('En ruta desde las 09:05 · Te llega la lista cuando finalice');
    expect(botones(t)).toEqual([]);
  });

  it('surtida: discreta, con quién y a qué hora', async () => {
    await montar();
    const t = tarjeta('surtida')!;
    expect(t.textContent!.replace(/\s+/g, ' ')).toContain('Ruta de Juan Pérez · Surtida por Ángel Cisneros a las 10:40');
    expect(botones(t)).toEqual([]);
  });

  it('⭐ error ≠ vacío: si no cargan, lo dice con Reintentar; reintentar vuelve a pedirlas', async () => {
    api.routes = vi.fn(() => throwError(() => ({ status: 500 })));
    await montar();
    expect(texto()).toContain('No se pudieron cargar las rutas');
    const r = Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Reintentar')) as HTMLButtonElement;
    expect(r).toBeTruthy();
    r.click();
    expect(api.routes).toHaveBeenCalledTimes(2);
  });

  it('sin rutas hoy no pinta nada: ni título ni texto de relleno', async () => {
    api.routes = vi.fn(() => of(BANDEJA([])));
    await montar();
    expect(texto().trim()).toBe('');
  });
});
