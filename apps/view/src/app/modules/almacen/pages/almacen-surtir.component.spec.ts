import { AlertsSocketService } from '../../dashboard/command-center/alerts-socket.service';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router, UrlTree } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import type {
  PickerTakeNextResponse, PickerWave, PickerWaveLine, PresalePickDetail, PresalePickInboxResponse, PresalePickInboxRow,
} from '@megadulces/contracts';
import { AlmacenSurtirComponent } from './almacen-surtir.component';
import { PickingService } from '../../reparto/picking.service';
import { PresalePickingService } from '../presale-picking.service';
import { AuthService } from '../../../core/services/auth.service';
import { ClientesNuevosService } from '../clientes-nuevos.service';

/** [MCP.3.1] Un pedido de Sucursal (app de vendor) en la lista del surtidor. */
const PV = (p: Partial<PresalePickInboxRow> = {}): PresalePickInboxRow => ({
  order_id: 'o-rosy', code: 'PD-2026-00082', customer_name: 'ABARROTES ROSY', seller_name: 'Vendedora Prueba',
  warehouse_id: 'w-ph', warehouse_name: 'Padre Hidalgo', requested_delivery_date: '2026-10-19',
  bucket: 'hoy', days_late: 0, arrived_at: '2026-10-19T19:12:00.000Z', lines: 2, total: 475.44,
  state: 'nuevo', started: null, finished: null, unseen: true, ...p,
});

const BANDEJA = (data: PresalePickInboxRow[] = [
  PV(),
  // [MCP.24] Atrasado de verdad: se prometió para el sábado 17 y hoy es lunes 19.
  PV({ order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO', days_late: 2, requested_delivery_date: '2026-10-17' }),
  PV({ order_id: 'o-esc', code: 'PD-2026-00083', customer_name: 'ESCUELA AMARILLA', bucket: 'manana', requested_delivery_date: '2026-10-20' }),
  PV({ order_id: 'o-otra', code: 'PD-2026-00090', customer_name: 'DE OTRA SUCURSAL', warehouse_id: 'w-lp' }),
  PV({ order_id: 'o-hecho', code: 'PD-2026-00060', customer_name: 'YA SURTIDO', state: 'completo' }),
]): PresalePickInboxResponse => ({ today: '2026-10-19', counts: { hoy: 2, manana: 1, proximos: 0 }, scope: 'propios', data });

const DETALLE = (): PresalePickDetail => ({
  order: PV({ state: 'surtiendo', started: { user_id: 'yo', name: 'Ángel Cisneros', at: '2026-10-19T19:30:00.000Z' } }),
  lines: [
    { line_id: 'pl1', product_id: 'p1', sku: '70012', barcode: '7500000000012', product_name: 'BOMBON GRANDE', qty: 5, unit: 'PAQ', factor: 1, picked: null },
    { line_id: 'pl2', product_id: 'p2', sku: '99124', barcode: null, product_name: 'SALSA MAGA', qty: 2, unit: 'CJA', factor: 12, picked: null },
  ],
});

/**
 * `[GP.3b]` La pantalla del surtidor, montada de verdad (plantilla + signals) con el servidor
 * simulado. Recorre lo que hace una persona con el celular en la mano: retomar, tomar, marcar
 * Completo / Faltante / No había, corregir, cerrar, quedarse sin trabajo y los errores.
 *
 * Se prueba por la PANTALLA (botones, textos, deshabilitados) y no sólo por los métodos: un
 * botón que se pinta pero no hace nada, o que queda habilitado cuando no debe, es justo el tipo
 * de defecto que `tsc` no ve.
 */

/** Lo que devuelve GET /reparto/surtido/almacenes: sólo sucursales de 2 dígitos del alcance. */
const ALMACENES = [
  { id: 'w-ph', code: '01', nombre: 'Padre Hidalgo' },
  { id: 'w-lp', code: '02', nombre: 'La Piedad Abastos' },
];

const L = (p: Partial<PickerWaveLine> = {}): PickerWaveLine => ({
  id: 'l1',
  product_id: 'p1',
  product_name: 'CHOC RANITA CROA',
  sku: '70034',
  barcode: '7501234567890',
  qty_requested: 75,
  qty_unit: 'KG',
  unidad_mixta: false,
  qty_presentacion: 3,
  unidad_presentacion: 'BTO',
  qty_picked: null,
  status: 'pendiente',
  bin_code: null,
  note: null,
  existencia: 300,
  existencia_unidad: 'KG',
  aviso_caja: null,
  ...p,
});

const OLA = (lines: PickerWaveLine[] = [L()]): PickerWave => ({
  id: 'ola-1',
  code: 'W-2026-00001',
  warehouse_id: 'w-ph',
  status: 'en_surtido',
  notes: null,
  started_at: '2026-10-08T15:00:00.000Z',
  pedidos: ['UD4001-0002840'],
  existencia_al: new Date(Date.now() - 42 * 60000).toISOString(),
  lines,
});

const ASIGNADA = (ola: PickerWave = OLA(), extra: Partial<PickerTakeNextResponse> = {}): PickerTakeNextResponse =>
  ({ estado: 'asignada', ya_era_tuya: false, ola, atoradas: [], ...extra }) as PickerTakeNextResponse;

describe('AlmacenSurtirComponent · la pantalla del surtidor (GP.3b)', () => {
  let fix: ComponentFixture<AlmacenSurtirComponent>;
  let c: AlmacenSurtirComponent;
  let api: {
    misOlas: ReturnType<typeof vi.fn>;
    tomarSiguiente: ReturnType<typeof vi.fn>;
    pick: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    almacenesSurtido: ReturnType<typeof vi.fn>;
  };
  let user: { warehouse_code?: string; sub?: string } | null;
  let pv: Record<'inbox' | 'detail' | 'start' | 'finish' | 'routes' | 'routeStart' | 'otherUnits', ReturnType<typeof vi.fn>>;
  /** [MCP.3.8] El aviso de clientes nuevos sin clave de Kepler. */
  let cn: { resumen: ReturnType<typeof vi.fn> };

  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const texto = (): string => el().textContent?.replace(/\s+/g, ' ') ?? '';
  /** La cantidad como la oyen y la leen: número y unidad van en piezas separadas para verse grandes. */
  const cantidades = (): string[] =>
    Array.from(el().querySelectorAll('.sr-cant')).map((n) => n.getAttribute('aria-label') ?? '');
  const boton =(t: string): HTMLButtonElement | undefined =>
    Array.from(el().querySelectorAll('button')).find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').includes(t)) as
      | HTMLButtonElement
      | undefined;
  const clic = (t: string): void => {
    const b = boton(t);
    if (!b) throw new Error(`no hay botón «${t}»`);
    b.click();
    fix.detectChanges();
  };

  /**
   * `origen`: la pantalla SIEMPRE abre en Sucursal ([MCP.3.6]). Las pruebas del surtido de olas
   * (Telemarketing) lo eligen como lo haría el surtidor; `'abre'` deja la pestaña con la que abre.
   */
  async function montar(query: Record<string, string> = {}, origen: 'TELEMARK' | 'abre' = 'TELEMARK'): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [AlmacenSurtirComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
        { provide: PickingService, useValue: api },
        { provide: PresalePickingService, useValue: pv },
        { provide: AuthService, useValue: { user: () => user } },
        { provide: ClientesNuevosService, useValue: cn },
        { provide: AlertsSocketService, useValue: { connect: () => undefined, alert$: new Subject<{ type: string }>() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenSurtirComponent);
    c = fix.componentInstance;
    fix.detectChanges();
    if (origen === 'TELEMARK' && !query['pedido']) {
      c.elegirOrigen('TELEMARK');
      fix.detectChanges();
    }
  }

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* sin almacenamiento */
    }
    user = { warehouse_code: '01', sub: 'yo' };
    cn = { resumen: vi.fn(() => of({ scope: 'propios', customers: 0, order_ids: [] })) };
    pv = {
      inbox: vi.fn(() => of(BANDEJA())),
      // [MCP.3.6] Sin rutas hoy, salvo que la prueba diga otra cosa.
      routes: vi.fn(() => of({ today: '2026-10-19', data: [], scope: 'propios' })),
      routeStart: vi.fn(() => of({})),
      detail: vi.fn(() => of(DETALLE())),
      otherUnits: vi.fn(() => of({ for_line_id: '', product_id: '', product_name: '', ordered: 0, unit: 'PZA', factor: 1, units: [] })),
      start: vi.fn(() => of(DETALLE().order)),
      finish: vi.fn(() => of({
        order_id: 'o-rosy', outcome: 'con_faltantes',
        report: { removed: [{ product_name: 'SALSA MAGA', unit: 'CJA', ordered: 2, picked: 0 }], adjusted: [], total_before: 475.44, total_after: 161.4 },
      })),
    };
    api = {
      misOlas: vi.fn(() => of([])),
      tomarSiguiente: vi.fn(() => of(ASIGNADA())),
      pick: vi.fn((_w: string, lineId: string, dto: { qty_picked: number; status?: string }) => {
        const st = dto.status ?? (dto.qty_picked === 0 ? 'agotado' : dto.qty_picked < 75 ? 'faltante' : 'surtido');
        return of({ id: lineId, qty_picked: dto.qty_picked, status: st });
      }),
      finish: vi.fn(() => of({ id: 'ola-1', status: 'surtida', cambios_en_kepler: [] })),
      almacenesSurtido: vi.fn(() => of(ALMACENES)),
    };
  });

  afterEach(() => TestBed.resetTestingModule());

  // ── Arranque ────────────────────────────────────────────────────────────────────────────

  it('monta, y sin ola pendiente queda lista para tomar trabajo', async () => {
    await montar();
    expect(c.fase()).toBe('listo');
    expect(boton('Tomar siguiente')).toBeTruthy();
  });

  it('sólo ofrece sucursales Kepler (código de 2 dígitos): ni camiones ni sub-almacenes de ruta', async () => {
    await montar();
    expect(c.almacenes().map((a) => a.code)).toEqual(['01', '02']);
  });

  it('el almacén por omisión es el de la ficha del usuario', async () => {
    await montar();
    expect(c.almacenId()).toBe('w-ph');
    expect(texto()).toContain('Padre Hidalgo');
  });

  it('sin almacén en la ficha ni guardado, "Tomar siguiente" está apagado (prueba negativa)', async () => {
    user = {};
    await montar();
    expect(c.almacenId()).toBe('');
    expect(boton('Tomar siguiente')?.disabled).toBe(true);
  });

  it('⭐ si ya traía una ola, la RETOMA con tomarSiguiente (que la arranca), no pintándola tal cual', async () => {
    api.misOlas = vi.fn(() => of([OLA()]));
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA(), { ya_era_tuya: true })));
    await montar();
    expect(api.tomarSiguiente).toHaveBeenCalledWith({ warehouse_id: 'w-ph', origen: 'TELEMARK' });
    expect(c.fase()).toBe('surtiendo');
  });

  it('⭐ si al RETOMAR falla la red, no se queda cargando para siempre: vuelve a "listo" con el error', async () => {
    api.misOlas = vi.fn(() => of([OLA()]));
    api.tomarSiguiente = vi.fn(() => throwError(() => ({ status: 0, error: { message: 'sin conexión' } })));
    await montar();
    expect(c.fase()).toBe('listo');
    expect(texto()).not.toContain('Cargando');
    expect(texto()).toContain('sin conexión');
    expect(boton('Reintentar')).toBeTruthy();
  });

  it('⭐ pide los almacenes al módulo de surtido (con el permiso de surtir) y elige el de la persona', async () => {
    await montar();
    expect(api.almacenesSurtido).toHaveBeenCalled();
    expect(c.almacenId()).toBe('w-ph');
    expect(texto()).toContain('01 · Padre Hidalgo');
  });

  it('si no puede leer los almacenes, lo dice y ofrece reintentar', async () => {
    api.almacenesSurtido = vi.fn(() => throwError(() => new Error('red')));
    await montar();
    expect(texto()).toContain('No se pudo leer la lista de almacenes');
    expect(boton('Reintentar')).toBeTruthy();
  });

  // ── Tomar trabajo ───────────────────────────────────────────────────────────────────────

  it('tomar manda el almacén y el origen elegido', async () => {
    await montar();
    clic('Telemarketing');
    clic('Tomar siguiente');
    expect(api.tomarSiguiente).toHaveBeenCalledWith({ warehouse_id: 'w-ph', origen: 'TELEMARK' });
  });

  it('[MCP.3.6] siempre abre en Sucursal, aunque la última vez se haya elegido Telemarketing', async () => {
    await montar({}, 'abre');
    clic('Telemarketing');
    expect(c.origen()).toBe('TELEMARK');
    TestBed.resetTestingModule();
    await montar({}, 'abre');
    expect(c.origen()).toBe('SUCURSAL');
  });

  // ── [MCP.3.1] Sucursal: los pedidos de la app, en esta misma pantalla ─────────────────

  it('⭐ sólo dos orígenes, Sucursal primero (ya no hay "Todos", que mezclaba)', async () => {
    await montar();
    const chips = Array.from(el().querySelectorAll('.sr-chip')).map((b) => b.textContent?.trim());
    expect(chips).toEqual(['Sucursal', 'Telemarketing']);
  });

  it('[MCP.3.2] en Telemarketing hay "Ver la lista de pedidos" y lleva al tablero (vista del surtidor)', async () => {
    await montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    clic('Ver la lista de pedidos');
    expect(String(nav.mock.calls[0][0])).toBe('/almacen/pedidos');
  });

  it('[MCP.3.6] lo guardado de antes (Telemarketing o el viejo "Todos") ya no decide: abre en Sucursal', async () => {
    localStorage.setItem('gp.surtir.origen.v1', 'TELEMARK');
    await montar({}, 'abre');
    expect(c.origen()).toBe('SUCURSAL');
    localStorage.setItem('gp.surtir.origen.v1', '');
    TestBed.resetTestingModule();
    await montar({}, 'abre');
    expect(c.origen()).toBe('SUCURSAL');
  });

  it('prueba negativa: "Tomar siguiente" sólo pide Telemarketing, nunca todo mezclado', async () => {
    await montar();
    clic('Tomar siguiente');
    for (const [arg] of api.tomarSiguiente.mock.calls) expect(arg.origen).toBe('TELEMARK');
  });

  it('⭐ Sucursal lista AQUÍ los pedidos de la app de hoy, sin "Tomar siguiente" ni otra pantalla', async () => {
    await montar();
    clic('Sucursal');
    expect(pv.inbox).toHaveBeenCalled();
    expect(boton('Tomar siguiente')).toBeFalsy();
    expect(texto()).toContain('ABARROTES ROSY');
    expect(texto()).toContain('Vendedora Prueba');
    expect(texto()).not.toContain('ESCUELA AMARILLA'); // es de mañana
  });

  it('⭐ [MCP.24] Hoy no mezcla lo atrasado: va en un aviso, por día, y tocar el día lo abre', async () => {
    await montar();
    clic('Sucursal');
    expect(texto()).toContain('Hoy · 1');
    expect(texto()).not.toContain('VERO VASCO');
    expect(texto()).toContain('1 pedido pendiente de días anteriores');
    clic('sáb 17 oct · 1');
    expect(texto()).toContain('VERO VASCO');
    expect(texto()).toContain('Atrasado 2 días');
    expect(texto()).not.toContain('ABARROTES ROSY');
    // Con el día atrasado abierto, el aviso ya no se repite; una pestaña regresa a lo de hoy.
    expect(texto()).not.toContain('pendiente de días anteriores');
    clic('Hoy · 1');
    expect(texto()).toContain('ABARROTES ROSY');
    expect(texto()).not.toContain('VERO VASCO');
  });

  it('[MCP.24] prueba negativa: abrir un día atrasado muestra SÓLO los de ese día', async () => {
    pv['inbox'].mockReturnValue(of(BANDEJA([
      PV(),
      PV({ order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO', days_late: 2, requested_delivery_date: '2026-10-17' }),
      PV({ order_id: 'o-ayer', code: 'PD-2026-00072', customer_name: 'DE AYER', days_late: 1, requested_delivery_date: '2026-10-18' }),
    ])));
    await montar();
    clic('Sucursal');
    expect(texto()).toContain('2 pedidos pendientes de días anteriores');
    const dias = Array.from(el().querySelectorAll('.sr-atras .sr-chip')).map((n) => (n.textContent ?? '').trim());
    expect(dias).toEqual(['Ayer · 1', 'sáb 17 oct · 1']); // el más reciente primero
    clic('Ayer · 1');
    expect(texto()).toContain('DE AYER');
    expect(texto()).not.toContain('VERO VASCO');
  });

  it('[MCP.24] lo atrasado que YO empecé se queda en Hoy, arriba, y no se cuenta en el aviso', async () => {
    pv['inbox'].mockReturnValue(of(BANDEJA([
      PV(),
      PV({ order_id: 'o-mio', code: 'PD-2026-00071', customer_name: 'ATRASADO MIO', days_late: 1, requested_delivery_date: '2026-10-18',
        state: 'surtiendo', started: { user_id: 'yo', name: 'Surtidor Prueba', at: '2026-10-19T15:00:00.000Z' } }),
      PV({ order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO', days_late: 2, requested_delivery_date: '2026-10-17' }),
    ])));
    await montar();
    clic('Sucursal');
    const grupos = Array.from(el().querySelectorAll('.sr-grupo')).map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(grupos[0]).toBe('Los que estás surtiendo · 1 pedido');
    expect(texto()).toContain('ATRASADO MIO');
    expect(texto()).toContain('Hoy · 2');
    // Prueba negativa: el aviso cuenta sólo el de VERO (el mío no se cuenta dos veces).
    expect(texto()).toContain('1 pedido pendiente de días anteriores');
    expect(boton('Ayer · ')).toBeFalsy();
  });

  it('⭐ [MCP.24] dos vendedores: los chips dicen cuántos, elegir uno deja sólo los suyos y «Todos» los regresa', async () => {
    pv['inbox'].mockReturnValue(of(BANDEJA([
      PV({ order_id: 'u1', code: 'PD-2026-00101', customer_name: 'CLIENTE U1', seller_name: 'Vendedor Uno', arrived_at: '2026-10-19T14:00:00.000Z' }),
      PV({ order_id: 'd1', code: 'PD-2026-00102', customer_name: 'CLIENTE D1', seller_name: 'Vendedora Dos', arrived_at: '2026-10-19T14:30:00.000Z' }),
      PV({ order_id: 'u2', code: 'PD-2026-00103', customer_name: 'CLIENTE U2', seller_name: 'Vendedor Uno', arrived_at: '2026-10-19T15:00:00.000Z' }),
      PV({ order_id: 'mio', code: 'PD-2026-00104', customer_name: 'CLIENTE MIO', seller_name: 'Vendedora Dos', state: 'surtiendo',
        started: { user_id: 'yo', name: 'Surtidor Prueba', at: '2026-10-19T16:00:00.000Z' } }),
      PV({ order_id: 'm1', code: 'PD-2026-00110', customer_name: 'CLIENTE MANANA', seller_name: 'Vendedora Dos', bucket: 'manana', requested_delivery_date: '2026-10-20' }),
    ])));
    await montar();
    clic('Sucursal');
    const chips = Array.from(el().querySelectorAll('[aria-label="Vendedor"] .sr-chip')).map((n) => (n.textContent ?? '').trim());
    expect(chips).toEqual(['Todos · 4', 'Vendedor Uno · 2', 'Vendedora Dos · 2']);
    clic('Vendedora Dos · 2');
    const clientes = (): Array<string | undefined> => Array.from(el().querySelectorAll('.sr-ped-cli')).map((n) => n.textContent?.trim());
    // Lo que dice el chip es lo que se ve: el que estoy surtiendo de Dos (arriba) y su otro pedido.
    expect(clientes()).toEqual(['CLIENTE MIO', 'CLIENTE D1']);
    clic('Vendedor Uno · 2');
    expect(clientes()).toEqual(['CLIENTE U1', 'CLIENTE U2']);
    clic('Todos · 4');
    expect(el().querySelectorAll('.sr-ped').length).toBe(4);
    // Prueba negativa: en Mañana Uno no tiene pedidos; el vendedor elegido no deja la lista vacía: regresa a todos.
    clic('Vendedor Uno · 2');
    clic('Mañana · 1');
    expect(texto()).toContain('CLIENTE MANANA');
    expect(el().querySelector('[aria-label="Vendedor"]')).toBeNull(); // un solo vendedor ese día: sin chips
  });

  it('[MCP.24] prueba negativa: con un solo vendedor en el día no hay chips de vendedor', async () => {
    await montar();
    clic('Sucursal');
    expect(el().querySelector('[aria-label="Vendedor"]')).toBeNull();
  });

  it('[MCP.3.8] avisa de los clientes nuevos sin clave de Kepler y marca SÓLO sus pedidos', async () => {
    cn.resumen.mockReturnValue(of({ scope: 'propios', customers: 2, order_ids: ['o-vero'] }));
    await montar();
    clic('Sucursal');
    expect(texto()).toContain('2 clientes nuevos sin clave de Kepler');
    expect(texto()).toContain('1 pedido suyo espera');
    const tarjetas = (): string[] => Array.from(el().querySelectorAll('.sr-ped')).map((n) => (n.textContent ?? '').replace(/\s+/g, ' '));
    // Prueba negativa: un pedido de cliente con clave no se marca.
    expect(tarjetas().find((t) => t.includes('ABARROTES ROSY'))).not.toContain('sin clave de Kepler');
    clic('sáb 17 oct · 1'); // [MCP.24] VERO VASCO está atrasado: se abre su día
    expect(tarjetas().find((t) => t.includes('VERO VASCO'))).toContain('Cliente nuevo · sin clave de Kepler');
  });

  it('[MCP.3.8] sin clientes por ligar no hay aviso; si no se pudo revisar, lo dice (error ≠ vacío)', async () => {
    await montar();
    expect(texto()).not.toContain('sin clave de Kepler');
    TestBed.resetTestingModule();
    cn.resumen.mockReturnValue(throwError(() => new Error('red')));
    await montar();
    expect(texto()).toContain('No se pudo revisar si hay clientes nuevos sin clave de Kepler');
  });

  it('[MCP.3.13] la parte de un pedido agrupado se rotula; el pedido suelto no', async () => {
    pv['inbox'].mockReturnValue(of(BANDEJA([
      PV({ group_code: 'P-10482', group_parts: 2, group_other_warehouses: ['LPA'] }),
      PV({ order_id: 'o-vero', code: 'P-10482', customer_name: 'VERO VASCO', group_code: 'P-10482', group_parts: 2, group_other_warehouses: ['LPA'] }),
      PV({ order_id: 'o-suelto', code: 'PD-2026-00091', customer_name: 'SUELTO', group_code: null, group_parts: null, group_other_warehouses: [] }),
    ])));
    await montar();
    clic('Sucursal');
    const tarjetas = Array.from(el().querySelectorAll('.sr-ped')).map((n) => (n.textContent ?? '').replace(/\s+/g, ' '));
    expect(tarjetas.find((t) => t.includes('ABARROTES ROSY'))).toContain('Parte de P-10482 · también surte LPA');
    // El principal del grupo no dice «Parte de» sí mismo.
    expect(tarjetas.find((t) => t.includes('VERO VASCO'))).toContain('Pedido agrupado · también surte LPA');
    // Prueba negativa: un pedido suelto no lleva rótulo.
    const suelto = tarjetas.find((t) => t.includes('SUELTO')) ?? '';
    expect(suelto).not.toContain('Parte de');
    expect(suelto).not.toContain('Pedido agrupado');
  });

  it('separa Hoy / Mañana / Próximos y cuenta sólo lo pendiente de MI almacén', async () => {
    await montar();
    clic('Sucursal');
    expect(texto()).toContain('Hoy · 1'); // ni el de otra sucursal, ni el ya surtido, ni el atrasado ([MCP.24])
    expect(texto()).toContain('Mañana · 1');
    expect(texto()).toContain('Próximos · 0');
    expect(texto()).not.toContain('DE OTRA SUCURSAL');
    expect(texto()).not.toContain('YA SURTIDO');
    clic('Mañana');
    expect(texto()).toContain('ESCUELA AMARILLA');
    expect(texto()).not.toContain('ABARROTES ROSY');
  });

  it('[MCP.14] separa los pedidos por vendedor y en orden de folio; lo que yo empecé va primero y aparte', async () => {
    pv['inbox'].mockReturnValue(of(BANDEJA([
      PV({ order_id: 'a2', code: 'PD-2026-00095', customer_name: 'CLIENTE A2', seller_name: 'Vendedor A', arrived_at: '2026-10-19T15:00:00.000Z' }),
      PV({ order_id: 'b1', code: 'PD-2026-00091', customer_name: 'CLIENTE B1', seller_name: 'Vendedor B', arrived_at: '2026-10-19T16:00:00.000Z' }),
      PV({ order_id: 'a1', code: 'PD-2026-00093', customer_name: 'CLIENTE A1', seller_name: 'Vendedor A', arrived_at: '2026-10-19T17:00:00.000Z' }),
      PV({ order_id: 'sv', code: 'PD-2026-00080', customer_name: 'CLIENTE SV', seller_name: null }),
      PV({ order_id: 'mio', code: 'PD-2026-00099', customer_name: 'CLIENTE MIO', seller_name: 'Vendedor B', state: 'surtiendo',
        started: { user_id: 'yo', name: 'Surtidor Prueba', at: '2026-10-19T18:00:00.000Z' } }),
    ])));
    await montar();
    clic('Sucursal');
    const grupos = Array.from(el().querySelectorAll('.sr-grupo')).map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(grupos).toEqual(['Los que estás surtiendo · 1 pedido', 'Vendedor A · 2 pedidos', 'Vendedor B · 1 pedido', 'Sin vendedor · 1 pedido']);
    const clientes = Array.from(el().querySelectorAll('.sr-ped-cli')).map((n) => n.textContent?.trim());
    // A llegó primero (15:00) y dentro va por folio: 00093 antes que 00095. Sin vendedor, al final.
    expect(clientes).toEqual(['CLIENTE MIO', 'CLIENTE A1', 'CLIENTE A2', 'CLIENTE B1', 'CLIENTE SV']);
    // Dentro de su grupo la tarjeta no repite el vendedor; en «Los que estás surtiendo» sí, porque ahí se mezclan.
    const tarjetas = Array.from(el().querySelectorAll('.sr-ped')).map((n) => (n.textContent ?? '').replace(/\s+/g, ' '));
    expect(tarjetas.find((t) => t.includes('CLIENTE MIO'))).toContain('Vendedor B');
    expect(tarjetas.find((t) => t.includes('CLIENTE A1'))).not.toContain('Vendedor A');
    // Prueba negativa: ningún pedido se pierde ni se duplica al agrupar.
    expect(el().querySelectorAll('.sr-ped').length).toBe(5);
  });

  it('⭐ "Surtir este" empieza el pedido (queda quién y a qué hora) y lo abre con los MISMOS renglones', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este'); // [MCP.24] el único de hoy: ABARROTES ROSY (VERO VASCO está atrasado, en su aviso)
    expect(pv.start).toHaveBeenCalledWith('o-rosy');
    expect(pv.detail).toHaveBeenCalledWith('o-rosy');
    expect(c.fase()).toBe('surtiendo');
    expect(texto()).toContain('BOMBON GRANDE');
    expect(cantidades()).toContain('Surtir 5 PAQ');
    expect(cantidades()).toContain('Surtir 2 CJA');
    expect(boton('Completo')).toBeTruthy();
    expect(boton('Faltante')).toBeTruthy();
    // No es una ola: no se guarda renglón por renglón en el servidor de olas.
    expect(texto()).not.toContain('Existencia');
  });

  it('el escáner encuentra el renglón del pedido de sucursal por su código de barras', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    c.busqueda.set('7500000000012');
    fix.detectChanges();
    expect(c.visibles().map((l) => l.product_name)).toEqual(['BOMBON GRANDE']);
  });

  // ── [MCP.23] La existencia del sistema por renglón, también en esta puerta ─────────────
  const conExistencia = (): PresalePickDetail => {
    const d = DETALLE();
    d.lines[0].stock = { state: 'con_existencia', qty: 15, checked_at: '2026-10-19T19:50:00.000Z' };
    d.lines[1].stock = { state: 'agotado', qty: 0, checked_at: '2026-10-19T19:40:00.000Z' };
    return d;
  };

  it('⭐ [MCP.23] al surtir un pedido de Sucursal, cada renglón dice lo que tiene el sistema', async () => {
    pv.detail = vi.fn(() => of(conExistencia()));
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    const sistema = Array.from(el().querySelectorAll('.sr-sistema')).map((n) => n.textContent?.trim());
    expect(sistema).toEqual(['Sistema: hay 15 PAQ', 'Sistema: no hay']);
    expect(el().querySelector('.sr-sistema-no')?.textContent).toContain('no hay');
    // Arriba del pedido no van notas de explicación (las quitó David, 2026-11-13): sólo el cliente y el vendedor.
    const arriba = el().querySelector('.sr-ola')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(arriba).toContain('ABARROTES ROSY · Vendedora Prueba');
    expect(arriba).not.toContain('celular');
    expect(arriba).not.toContain('«Sistema»');
  });

  it('⭐ [MCP.23] faltante de algo que el sistema dice que hay: pide buscarlo en bodega, sin bloquear', async () => {
    pv.detail = vi.fn(() => of(conExistencia()));
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    clic('Faltante'); // BOMBON GRANDE: 5 PAQ, el sistema dice 15
    expect(texto()).toContain('El sistema dice que hay 15 PAQ: búscalo en bodega antes de quitarlo.');
    c.borrador.set(5);
    fix.detectChanges();
    expect(texto()).not.toContain('búscalo en bodega'); // completo: no hay nada que buscar
    c.borrador.set(2);
    fix.detectChanges();
    expect(texto()).toContain('búscalo en bodega');
    expect(boton('Guardar')?.disabled).toBe(false); // avisa, no bloquea
    clic('Guardar');
    // Ya marcado con faltante, el aviso sigue a la vista para corregir.
    expect(texto()).toContain('El sistema dice que hay 15 PAQ: búscalo en bodega antes de quitarlo.');
    // Prueba negativa: lo que el sistema dice que NO hay no pide buscar.
    c.noHabia(c.pendientes()[0]); // SALSA MAGA, agotado
    fix.detectChanges();
    expect(texto().match(/búscalo en bodega/g)?.length).toBe(1);
  });

  it('[MCP.23] prueba negativa: sin existencia del servidor no pinta nada; si no se pudo leer dice «sin dato», nunca cero', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este'); // DETALLE sin `stock`: servidor anterior
    expect(el().querySelector('.sr-sistema')).toBeNull();
    expect(texto()).not.toContain('«Sistema»');
    TestBed.resetTestingModule();
    const d = DETALLE();
    d.lines[0].stock = null;
    pv.detail = vi.fn(() => of(d));
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    expect(el().querySelector('.sr-sistema')?.textContent).toContain('Sistema: sin dato');
  });

  it('⭐ marcar en Sucursal NO llama al guardado de olas; se cierra con lo que hubo y muestra el reporte', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    clic('Completo'); // BOMBON GRANDE
    c.noHabia(c.pendientes()[0]); // SALSA MAGA
    fix.detectChanges();
    expect(api.pick).not.toHaveBeenCalled();
    clic('Terminé de surtir');
    // [MCP.18] El faltante viaja con su motivo: sin tocar, el de por omisión («No había en la sucursal»).
    expect(pv.finish).toHaveBeenCalledWith('o-rosy', { lines: [{ line_id: 'pl1', picked: 5 }, { line_id: 'pl2', picked: 0, reason: 'sin_existencia' }] });
    expect(api.finish).not.toHaveBeenCalled();
    expect(c.fase()).toBe('cerrada');
    expect(texto()).toContain('Se quitó SALSA MAGA');
    expect(texto()).toContain('ya se le avisó a la vendedora');
    expect(boton('Ver pedidos')).toBeTruthy();
    expect(boton('Tomar siguiente')).toBeFalsy();
  });

  // ── [MCP.17] Pidieron CJA y no hubo caja completa: el mismo producto en otra unidad ──────
  /** SALSA MAGA pide 2 CJA de 12: Kepler la vende también en PZA y en PAQ de 6. */
  const UNIDADES = () => ({
    for_line_id: 'pl2', product_id: 'p2', product_name: 'SALSA MAGA', ordered: 2, unit: 'CJA', factor: 12,
    units: [{ unit: 'PZA', factor: 1, price: 5 }, { unit: 'PAQ', factor: 6, price: 28 }],
  });
  const sinSalsa = async (): Promise<void> => {
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    clic('Completo'); // BOMBON GRANDE
    c.noHabia(c.pendientes()[0]); // SALSA MAGA: no hubo las 2 CJA
    fix.detectChanges();
  };

  describe('[MCP.18] el porqué de lo que faltó (Sucursal)', () => {
    const radio = (t: string): HTMLButtonElement =>
      Array.from((fix.nativeElement as HTMLElement).querySelectorAll('[role="radio"]')).find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement;

    it('el renglón sin existencia pregunta «¿Por qué?» con «No había en la sucursal» marcado; el completo no', async () => {
      await sinSalsa();
      expect((fix.nativeElement as HTMLElement).querySelectorAll('app-motivo-chips').length).toBe(1);
      expect(radio('No había en la sucursal').getAttribute('aria-checked')).toBe('true');
    });

    it('elegir «Dañado o caducado» viaja al cerrar, y se guarda en el celular hasta cerrar', async () => {
      await sinSalsa();
      radio('Dañado o caducado').click();
      fix.detectChanges();
      expect(JSON.parse(localStorage.getItem('gp.surtir.preventa.motivo.v1.o-rosy') || '{}')).toEqual({ pl2: { reason: 'danado', note: '' } });
      clic('Terminé de surtir');
      expect(pv.finish.mock.calls[0][1].lines[1]).toEqual({ line_id: 'pl2', picked: 0, reason: 'danado' });
      expect(localStorage.getItem('gp.surtir.preventa.motivo.v1.o-rosy') || '').toBe('');
    });

    it('negativa: «Otro motivo» sin escribir detiene «Terminé de surtir» y lo dice', async () => {
      await sinSalsa();
      radio('Otro motivo').click();
      fix.detectChanges();
      expect(texto()).toContain('Escribe cuál fue el «Otro motivo»');
      expect(boton('Terminé de surtir')?.disabled).toBe(true);
      boton('Terminé de surtir')?.click();
      expect(pv.finish).not.toHaveBeenCalled();
    });

    it('D5: el surtidor ve todo el porqué del pedido al abrirlo (la vendedora y lo que ya se quitó)', async () => {
      pv.detail = vi.fn(() => of({ ...DETALLE(), justifications: [
        { actor: 'seller', action: 'reopened', by_name: 'Vendedora Prueba', at: '2026-11-10T15:00:00.000Z', product_name: null, detail: null, reason: 'El cliente quiere agregar productos' },
        // D5 (David, 2026-11-11): los tres roles ven todo; antes al surtir sólo se veía lo de la vendedora.
        { actor: 'picker', action: 'removed', by_name: 'Otro Surtidor', at: '2026-11-10T15:30:00.000Z', product_name: 'CHICLE', detail: '1 PAQ', reason: null },
      ] }));
      await montar();
      clic('Sucursal');
      clic('Surtir este');
      expect(texto()).toContain('Por qué cambió este pedido');
      expect(texto()).toContain('Corrigió el pedido. Motivo: El cliente quiere agregar productos');
      expect(texto()).toContain('Quitó CHICLE');
    });
  });

  it('⭐ [MCP.17] lo que faltó se surte en PAQ del mismo producto y viaja al cerrar como cambio con su mismo producto', async () => {
    pv['otherUnits'] = vi.fn(() => of(UNIDADES()));
    await sinSalsa();
    clic('Surtir en otra unidad');
    expect(pv['otherUnits']).toHaveBeenCalledWith('o-rosy', 'pl2');
    // Elige sola la más grande de las chicas (de una caja salen paquetes), y dice cuántos caben: 2 CJA × 12 / 6 = 4.
    expect(c.otraElegida()).toBe('PAQ');
    expect(texto()).toContain('No hubo CJA completa');
    expect(texto()).toContain('Caben hasta 4');
    c.otraCant.set(3);
    fix.detectChanges();
    clic('Poner');
    expect(texto()).toContain('Van 3 PAQ en otra unidad');
    clic('Terminé de surtir');
    expect(pv.finish).toHaveBeenCalledWith('o-rosy', { lines: [
      { line_id: 'pl1', picked: 5 },
      { line_id: 'pl2', picked: 0, substitute: { product_id: 'p2', unit: 'PAQ', quantity: 3 }, reason: 'sin_existencia' },
    ] });
  });

  it('[MCP.17] prueba negativa: más de lo que faltó no se puede poner, y lo dice', async () => {
    pv['otherUnits'] = vi.fn(() => of(UNIDADES()));
    await sinSalsa();
    clic('Surtir en otra unidad');
    c.otraCant.set(5); // caben 4 PAQ
    fix.detectChanges();
    expect(boton('Poner')?.disabled).toBe(true);
    expect(texto()).toContain('no se surte más de lo que faltó');
    // En piezas caben 24.
    c.otraElegida.set('PZA');
    c.otraCant.set(24);
    fix.detectChanges();
    expect(boton('Poner')?.disabled).toBe(false);
  });

  it('[MCP.17] si Kepler no tiene nada más chico lo dice; si cambia lo surtido, lo de otra unidad se quita', async () => {
    pv['otherUnits'] = vi.fn(() => of({ ...UNIDADES(), units: [] }));
    await sinSalsa();
    clic('Surtir en otra unidad');
    expect(texto()).toContain('Kepler no tiene una presentación más chica que CJA');
    expect(boton('Poner')?.disabled).toBe(true);
    // Con presentaciones: se pone, y luego se corrige el renglón a «Completo».
    pv['otherUnits'] = vi.fn(() => of(UNIDADES()));
    clic('Cancelar');
    clic('Surtir en otra unidad');
    c.otraCant.set(2);
    fix.detectChanges();
    clic('Poner');
    c.completo(c.ola()!.lines.find((l) => l.id === 'pl2')!);
    fix.detectChanges();
    expect(texto()).not.toContain('en otra unidad');
    expect(c.anuncio()).toContain('Lo de otra unidad se quitó');
    clic('Terminé de surtir');
    expect(pv.finish).toHaveBeenCalledWith('o-rosy', { lines: [{ line_id: 'pl1', picked: 5 }, { line_id: 'pl2', picked: 2 }] });
  });

  it('[MCP.17] prueba negativa: en Telemarketing (olas de Kepler) no se ofrece', async () => {
    await montar();
    clic('Tomar siguiente');
    c.noHabia(c.pendientes()[0]);
    fix.detectChanges();
    expect(boton('Surtir en otra unidad')).toBeFalsy();
  });

  // ── [MCP.3.15] Indicaciones del vendedor ───────────────────────────────────────────────
  const IND = 'Las Sabritas con caducidad de diciembre en adelante. Bajar por la puerta de atrás.';
  const conIndicaciones = (): void => {
    pv['inbox'].mockReturnValue(of(BANDEJA([PV({ instructions: IND }), PV({ order_id: 'o-vero', code: 'PD-2026-00070', customer_name: 'VERO VASCO' })])));
    pv['detail'].mockReturnValue(of({ ...DETALLE(), order: { ...DETALLE().order, instructions: IND } }));
  };

  it('[MCP.3.15] en la bandeja, el pedido con indicaciones lo dice; el que no trae, no', async () => {
    conIndicaciones();
    await montar();
    clic('Sucursal');
    const tarjetas = Array.from(el().querySelectorAll('.sr-ped')).map((n) => (n.textContent ?? '').replace(/\s+/g, ' '));
    expect(tarjetas.find((t) => t.includes('ABARROTES ROSY'))).toContain('Con indicaciones del vendedor');
    expect(tarjetas.find((t) => t.includes('VERO VASCO'))).not.toContain('Con indicaciones');
  });

  it('[MCP.3.15] al surtir, las indicaciones salen completas en el recuadro de arriba de la lista', async () => {
    conIndicaciones();
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    const caja = el().querySelector('.sr-ind');
    expect(caja).toBeTruthy();
    expect(caja?.getAttribute('role')).toBe('note');
    expect(caja?.querySelector('.sr-ind-txt')?.textContent).toBe(IND);
    // Va antes que los renglones: lo primero que lee el surtidor.
    const primerRenglon = el().querySelector('.sr-cant');
    expect(caja && primerRenglon && (caja.compareDocumentPosition(primerRenglon) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  });

  it('[MCP.3.15] con indicaciones, «Terminé de surtir» espera a «Cumplí las indicaciones»', async () => {
    conIndicaciones();
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    clic('Completo');
    clic('Completo');
    expect(c.pendientesTotal()).toBe(0);
    expect(boton('Terminé de surtir')?.disabled).toBe(true);
    expect(texto()).toContain('Falta marcar «Cumplí las indicaciones»');
    const marca = el().querySelector<HTMLInputElement>('#sr-ind-ok');
    marca!.click();
    fix.detectChanges();
    expect(boton('Terminé de surtir')?.disabled).toBe(false);
    clic('Terminé de surtir');
    expect(pv['finish']).toHaveBeenCalled();
  });

  it('[MCP.3.15] prueba negativa: sin indicaciones no hay recuadro ni marca que pedir', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    expect(el().querySelector('.sr-ind')).toBeNull();
    clic('Completo');
    clic('Completo');
    expect(boton('Terminé de surtir')?.disabled).toBe(false);
    expect(texto()).not.toContain('Cumplí las indicaciones');
  });

  it('[MCP.3.15] la marca no se arrastra al siguiente pedido', async () => {
    conIndicaciones();
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    el().querySelector<HTMLInputElement>('#sr-ind-ok')!.click();
    fix.detectChanges();
    expect(c.indicacionesOk()).toBe(true);
    c['abrirPedido']({ ...DETALLE(), order: { ...DETALLE().order, order_id: 'o-otro', instructions: 'Otra cosa' } });
    fix.detectChanges();
    expect(c.indicacionesOk()).toBe(false);
    expect(c.faltaMarcarIndicaciones()).toBe(true);
  });

  it('prueba negativa: no deja cerrar con renglones sin tocar', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    clic('Completo');
    expect(boton('Terminé de surtir')?.disabled).toBe(true);
    expect(pv.finish).not.toHaveBeenCalled();
  });

  it('lo marcado se queda en el celular: si se cierra la app, al continuar sigue marcado', async () => {
    await montar();
    clic('Sucursal');
    clic('Surtir este');
    clic('Completo');
    TestBed.resetTestingModule();
    pv.inbox = vi.fn(() => of(BANDEJA([DETALLE().order]))); // sigue "surtiendo" a mi nombre
    await montar({}, 'abre'); // vuelve a abrir en Sucursal, donde quedó el pedido a medias
    clic('Continuar');
    const b = c.ola()!.lines.find((l) => l.id === 'pl1')!;
    expect(b.status).toBe('surtido');
    expect(b.qty_picked).toBe(5);
  });

  it('un pedido que surte OTRA persona se ve, pero no se puede tomar', async () => {
    pv.inbox = vi.fn(() => of(BANDEJA([PV({ state: 'surtiendo', started: { user_id: 'otro', name: 'Félix Herrera', at: '2026-10-19T19:00:00.000Z' } })])));
    await montar();
    clic('Sucursal');
    expect(texto()).toContain('Lo está surtiendo Félix Herrera');
    expect(boton('Surtir este')).toBeFalsy();
    expect(boton('Continuar')).toBeFalsy();
  });

  it('si otro lo tomó primero, lo dice y refresca la lista (no se queda atorado)', async () => {
    pv.start = vi.fn(() => throwError(() => ({ status: 409, error: { message: 'Ya lo está surtiendo Félix Herrera desde 13:05.' } })));
    await montar({}, 'abre'); // abre en Sucursal: la bandeja se pide una vez al abrir
    clic('Surtir este');
    expect(c.fase()).toBe('listo');
    expect(c.tomando()).toBe(false);
    expect(pv.inbox).toHaveBeenCalledTimes(2);
  });

  it('⭐ el aviso de la campana (?pedido=) abre ese pedido directo en esta pantalla', async () => {
    await montar({ pedido: 'o-rosy' });
    expect(c.origen()).toBe('SUCURSAL');
    expect(pv.start).toHaveBeenCalledWith('o-rosy');
    expect(c.fase()).toBe('surtiendo');
  });

  it('con un surtido de Telemarketing a medias, el aviso no lo abandona: primero lo retoma', async () => {
    api.misOlas = vi.fn(() => of([OLA()]));
    await montar({ pedido: 'o-rosy' });
    expect(pv.start).not.toHaveBeenCalled();
    expect(api.tomarSiguiente).toHaveBeenCalled();
  });

  it('⭐ con la ola tomada, la cantidad sale en la presentación de la hoja y la base debajo', async () => {
    await montar();
    clic('Tomar siguiente');
    expect(cantidades()).toEqual(['Surtir 3 BTO']);
    expect(texto()).toContain('= 75 KG');
    expect(texto()).toContain('UD4001-0002840');
  });

  it('sin presentación (pedido de la Suite) muestra la unidad base, sin el "=" de abajo', async () => {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA([L({ qty_presentacion: null, unidad_presentacion: null, qty_requested: 12, qty_unit: 'PAQ' })]))));
    await montar();
    clic('Tomar siguiente');
    expect(cantidades()).toEqual(['Surtir 12 PAQ']);
    expect(texto()).not.toContain('= 12');
  });

  it('una presentación en 0 se ignora: no muestra "0 BTO"', async () => {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA([L({ qty_presentacion: 0 })]))));
    await montar();
    clic('Tomar siguiente');
    expect(cantidades()).toEqual(['Surtir 75 KG']);
  });

  it('sin trabajo: lo dice y lista los pedidos bloqueados para avisar a la consola', async () => {
    api.tomarSiguiente = vi.fn(() =>
      of({
        estado: 'sin_trabajo',
        motivo: 'No hay pedidos autorizados por surtir en este almacén.',
        armado: {
          creadas: [], fallidas: [], vacios: [],
          bloqueados: [{ code: 'UD4001-0002999', motivo: '1 renglón(es) con clave fuera del catálogo' }],
          atorados: { count: 7, desde: '2026-07-15' },
        },
        atoradas: [],
      } as PickerTakeNextResponse),
    );
    await montar();
    clic('Tomar siguiente');
    expect(c.fase()).toBe('listo');
    expect(texto()).toContain('No hay pedidos por surtir');
    expect(texto()).toContain('UD4001-0002999');
    expect(texto()).toContain('7 pedidos siguen autorizados');
  });

  it('las olas de la consola que no arrancaron se avisan arriba', async () => {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA(), { atoradas: [{ code: 'W-2026-00007', motivo: 'clave fuera del catálogo' }] })));
    await montar();
    clic('Tomar siguiente');
    expect(texto()).toContain('Avísale a tu supervisor');
    expect(texto()).toContain('W-2026-00007');
  });

  it('si tomar falla, avisa y sigue en "listo" (no se queda cargando)', async () => {
    api.tomarSiguiente = vi.fn(() => throwError(() => ({ error: { message: 'sin conexión' } })));
    await montar();
    clic('Tomar siguiente');
    expect(c.tomando()).toBe(false);
    expect(c.fase()).toBe('listo');
  });

  // ── Surtir ──────────────────────────────────────────────────────────────────────────────

  async function surtiendo(lines: PickerWaveLine[] = [L()]): Promise<void> {
    api.tomarSiguiente = vi.fn(() => of(ASIGNADA(OLA(lines))));
    await montar();
    clic('Tomar siguiente');
  }

  it('⭐ Completo manda lo pedido en la unidad BASE y el renglón pasa a "Ya surtidos"', async () => {
    await surtiendo();
    clic('Completo');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 75, status: undefined });
    expect(c.pendientes().length).toBe(0);
    expect(c.hechas().length).toBe(1);
    expect(texto()).toContain('1 / 1');
  });

  it('⭐ Faltante se captura en la presentación (2 BTO) y se guarda convertido a la base (50 KG)', async () => {
    await surtiendo();
    clic('Faltante');
    expect(texto()).toContain('¿Cuánto levantaste? (BTO)');
    c.borrador.set(2);
    fix.detectChanges();
    clic('Guardar');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 50, status: undefined });
    expect(texto()).toContain('Faltaron 1 de 3 BTO');
  });

  // [GP.9.2] El caso Canindo: 10 CJA capturadas con caja de 40 (= 400 PAQ); hoy la CJA es de 25.
  const CANINDO = L({
    sku: '95644', product_name: 'CHILITO', qty_requested: 400, qty_unit: 'PAQ', qty_presentacion: 10, unidad_presentacion: 'CJA',
    existencia: 900, existencia_unidad: 'PAQ',
    aviso_caja: {
      tipo: 'capturada_con_otra', unidad: 'CJA', factor_antes: 40, factor_hoy: 25, desde: null,
      texto: 'El pedido se capturó con CJA de 40 y hoy la CJA es de 25. Cuenta 400 PAQ, no cajas.',
    },
  });

  it('⭐ [GP.9.2] caja capturada con otro factor: la hoja manda contar en la BASE (400 PAQ), no «10 CJA», y lo dice', async () => {
    await surtiendo([CANINDO]);
    expect(texto()).toContain('Cuenta 400 PAQ, no cajas.');
    expect(c.cantidadPrincipal(c.pendientes()[0])).toBe('400 PAQ');
    clic('Faltante');
    expect(texto()).toContain('¿Cuánto levantaste? (PAQ)');
    c.borrador.set(250);
    fix.detectChanges();
    clic('Guardar');
    // 250 PAQ tal cual — con el factor viejo habrían sido 250 × 40.
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 250, status: undefined });
  });

  it('[GP.9.2] caja en transición: se avisa, pero se sigue contando en la presentación de la hoja', async () => {
    await surtiendo([L({ aviso_caja: { tipo: 'transicion', unidad: 'BTO', factor_antes: 20, factor_hoy: 25, desde: '2026-11-10T16:00:00.000Z',
      texto: 'La BTO cambió de 20 a 25 el 10 nov: revisa cuántas piezas trae antes de contarla por caja.' } })]);
    expect(texto()).toContain('La BTO cambió de 20 a 25 el 10 nov');
    clic('Faltante');
    expect(texto()).toContain('¿Cuánto levantaste? (BTO)');
  });

  it('[GP.9.2] sin aviso no se pinta ninguna nota de caja (prueba negativa)', async () => {
    await surtiendo();
    expect(fix.nativeElement.querySelector('.sr-tip-caja')).toBeNull();
  });

  it('no deja guardar más de lo pedido (4 BTO de 3) ni el campo vacío (prueba negativa)', async () => {
    await surtiendo();
    clic('Faltante');
    c.borrador.set(4);
    fix.detectChanges();
    expect(boton('Guardar')?.disabled).toBe(true);
    c.borrador.set(null);
    fix.detectChanges();
    expect(boton('Guardar')?.disabled).toBe(true);
  });

  it('capturar la presentación completa guarda lo pedido EXACTO (sin 74.99999 por la división)', async () => {
    await surtiendo([L({ qty_requested: 61.74, qty_presentacion: 3 })]);
    clic('Faltante');
    c.borrador.set(3);
    fix.detectChanges();
    clic('Guardar');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 61.74, status: undefined });
  });

  it('No había manda 0 con causa "agotado"', async () => {
    await surtiendo();
    clic('Faltante');
    clic('No había');
    expect(api.pick).toHaveBeenCalledWith('ola-1', 'l1', { qty_picked: 0, status: 'agotado' });
    expect(texto()).toContain('No había');
  });

  it('un renglón ya surtido se puede corregir', async () => {
    await surtiendo();
    clic('Completo');
    clic('Corregir');
    expect(c.editando()).toBe('l1');
  });

  it('el buscador filtra por nombre o código', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', product_name: 'PAL JUMBO CEREZA', sku: '70079' })]);
    c.busqueda.set('70079');
    fix.detectChanges();
    expect(c.pendientes().map((l) => l.id)).toEqual(['l2']);
  });

  it('al marcar un renglón encontrado con el buscador, el buscador se limpia para escanear el siguiente', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', product_name: 'PAL JUMBO CEREZA', sku: '70079' })]);
    c.busqueda.set('70079');
    fix.detectChanges();
    clic('Completo');
    expect(c.busqueda()).toBe('');
    expect(c.pendientes().map((l) => l.id)).toEqual(['l1']);
  });

  it('⭐ el escáner encuentra el producto por su CÓDIGO DE BARRAS (lo que trae la etiqueta)', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', product_name: 'PAL JUMBO CEREZA', sku: '70079', barcode: '7509999999999' })]);
    c.busqueda.set('7509999999999');
    fix.detectChanges();
    expect(c.visibles().map((l) => l.id)).toEqual(['l2']);
  });

  it('⭐ escanear algo que no está en el surtido lo DICE (no "ya pasaste por todos")', async () => {
    await surtiendo();
    c.busqueda.set('000000');
    fix.detectChanges();
    expect(texto()).toContain('Ningún renglón de este surtido coincide');
    expect(texto()).not.toContain('Ya pasaste por todos');
  });

  it('Enter del escáner con una sola coincidencia lleva el foco a su "Completo" (no lo marca solo)', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079', barcode: '7509999999999' })]);
    c.busqueda.set('70079');
    fix.detectChanges();
    c.enterBuscar();
    expect(document.activeElement?.id).toBe('sr-ok-l2');
    expect(api.pick).not.toHaveBeenCalled();
  });

  it('⭐ un renglón marcado se queda EN SU LUGAR (encogido): la lista no se mueve bajo el dedo', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079' }), L({ id: 'l3', product_id: 'p3', sku: '70080' })]);
    const orden = (): string[] => c.visibles().map((l) => l.id);
    clic('Completo');
    expect(orden()).toEqual(['l1', 'l2', 'l3']);
    expect(el().querySelectorAll('.sr-hecho').length).toBe(1);
  });

  it('"Ocultar los ya surtidos" deja sólo lo pendiente', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079' })]);
    clic('Completo');
    clic('Ocultar los ya surtidos');
    expect(c.visibles().map((l) => l.id)).toEqual(['l2']);
  });

  it('el faltante dice el máximo, y explica por qué no deja guardar si se pasa', async () => {
    await surtiendo();
    clic('Faltante');
    expect(texto()).toContain('Entre 0 y 3 BTO');
    c.borrador.set(5);
    fix.detectChanges();
    expect(texto()).toContain('No puede ser más de 3 BTO');
  });

  it('sin conexión lo avisa arriba', async () => {
    await surtiendo();
    window.dispatchEvent(new Event('offline'));
    fix.detectChanges();
    expect(texto()).toContain('Sin conexión');
    window.dispatchEvent(new Event('online'));
    fix.detectChanges();
    expect(texto()).not.toContain('Sin conexión');
  });

  it('si guardar falla, el renglón sigue pendiente y los botones vuelven a servir', async () => {
    await surtiendo();
    api.pick = vi.fn(() => throwError(() => ({ status: 500, error: { message: 'caído' } })));
    clic('Completo');
    expect(c.pendientes().length).toBe(1);
    expect(c.guardando().size).toBe(0);
    expect(boton('Completo')?.disabled).toBe(false);
  });

  it('⭐ un 409 al guardar (la consola canceló la ola) regresa a "Tomar siguiente": no deja la pantalla sin salida', async () => {
    await surtiendo();
    api.pick = vi.fn(() => throwError(() => ({ status: 409, error: { message: 'La ola está cancelada' } })));
    clic('Completo');
    expect(c.fase()).toBe('listo');
    expect(c.ola()).toBeNull();
  });

  // ── [GP.3c] Existencia y ubicación ─────────────────────────────────────────────────────

  const datoExist = (): string => (el().querySelector('.sr-ren .sr-dato')?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('⭐ alcanza: "Hay 300 KG en el sistema", sin alarma', async () => {
    await surtiendo();
    expect(datoExist()).toBe('Hay 300 KG en el sistema');
    expect(c.existenciaEstado(c.ola()!.lines[0])).toBe('ok');
  });

  it('⭐ alcanza para menos de lo pedido: lo marca ANTES de caminar', async () => {
    await surtiendo([L({ existencia: 40 })]);
    expect(datoExist()).toBe('Hay sólo 40 KG en el sistema');
    expect(el().querySelector('.sr-exist-poca')).toBeTruthy();
  });

  it('existencia en cero: "Sin existencia en el sistema", en rojo', async () => {
    await surtiendo([L({ existencia: 0 })]);
    expect(datoExist()).toBe('Sin existencia en el sistema');
    expect(el().querySelector('.sr-exist-cero')).toBeTruthy();
  });

  it('sin dato (null) NO se dibuja como cero (prueba negativa)', async () => {
    await surtiendo([L({ existencia: null, existencia_unidad: null })]);
    expect(datoExist()).toBe('Existencia: sin dato en el sistema');
    expect(el().querySelector('.sr-exist-cero')).toBeNull();
  });

  it('unidad de existencia distinta a la del pedido: la muestra pero NO compara (0.35% medido)', async () => {
    await surtiendo([L({ qty_unit: 'PAQ', existencia: 5, existencia_unidad: 'KG' })]);
    expect(datoExist()).toBe('Hay 5 KG en el sistema (otra unidad, no se compara)');
    expect(el().querySelector('.sr-exist-poca')).toBeNull();
  });

  it('existencia negativa (ajuste pendiente en Kepler) no se lee igual que un cero', async () => {
    await surtiendo([L({ existencia: -4 })]);
    expect(datoExist()).toBe('Kepler marca existencia negativa');
  });

  it('dice de cuándo es la existencia, y la ubicación cuando no está dada de alta', async () => {
    await surtiendo();
    expect(texto()).toContain('Existencia de Kepler de hace 42 min');
    expect(texto()).toContain('Sin ubicación dada de alta');
  });

  it('con ubicación la muestra', async () => {
    await surtiendo([L({ bin_code: 'BC110' })]);
    expect(texto()).toContain('Ubicación BC110');
  });

  it('el botón principal apagado se ve GRIS, no naranja tenue', async () => {
    await surtiendo();
    const fin = boton('Terminé de surtir');
    expect(fin?.disabled).toBe(true);
    expect(fin?.classList.contains('sr-btn-go')).toBe(true);
  });

  // ── Cerrar ──────────────────────────────────────────────────────────────────────────────

  it('⭐ "Terminé de surtir" está apagado mientras haya renglones sin tocar', async () => {
    await surtiendo([L(), L({ id: 'l2', product_id: 'p2', sku: '70079' })]);
    expect(boton('Terminé de surtir')?.disabled).toBe(true);
    clic('Completo');
    expect(boton('Terminé de surtir')?.disabled).toBe(true);
    clic('Completo');
    expect(boton('Terminé de surtir')?.disabled).toBe(false);
  });

  it('al cerrar muestra el resumen y el aviso si el pedido cambió en Kepler', async () => {
    api.finish = vi.fn(() => of({ id: 'ola-1', status: 'surtida', cambios_en_kepler: ['clave 70034: 75 → 50'] }));
    await surtiendo();
    clic('Completo');
    clic('Terminé de surtir');
    expect(c.fase()).toBe('cerrada');
    expect(texto()).toContain('Surtido terminado');
    expect(texto()).toContain('1 renglón completo');
    expect(texto()).toContain('clave 70034: 75 → 50');
    expect(boton('Tomar siguiente')).toBeTruthy();
  });

  it('si cerrar falla, sigue surtiendo con la ola intacta', async () => {
    api.finish = vi.fn(() => throwError(() => ({ status: 500, error: { message: 'caído' } })));
    await surtiendo();
    clic('Completo');
    clic('Terminé de surtir');
    expect(c.fase()).toBe('surtiendo');
    expect(c.ola()).not.toBeNull();
    expect(c.cerrando()).toBe(false);
  });

  it('Salir va a /almacen y NO al tablero (el almacenista no tiene permiso de verlo: lo rebotaría)', async () => {
    await montar();
    const router = TestBed.inject(Router);
    const nav = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    clic('Salir');
    // `[MT.5.4]` Se afirma sobre el DESTINO, no sobre el mecanismo: desde que
    // «Salir» pasa por `irConservandoPanel` (para no tirar la pantalla partida)
    // el argumento es un `UrlTree`, no el texto. Fijar el texto habría hecho
    // fallar un cambio que no mueve a dónde va el botón.
    expect(nav).toHaveBeenCalledTimes(1);
    expect(router.serializeUrl(nav.mock.calls[0][0] as UrlTree)).toBe('/almacen');
  });

  // ── [MCP.3.6] Rutas de hoy arriba de los sueltos ─────────────────────────────────────────

  it('⭐ [MCP.3.6] si las rutas no cargan, lo dice con Reintentar y los pedidos sueltos SIGUEN', async () => {
    pv.routes = vi.fn(() => throwError(() => ({ status: 500 })));
    await montar();
    clic('Sucursal');
    expect(texto()).toContain('No se pudieron cargar las rutas');
    // Los sueltos de siempre, intactos y tomables.
    expect(texto()).toContain('ABARROTES ROSY');
    expect(boton('Surtir este')).toBeTruthy();
    expect(Array.from(el().querySelectorAll('app-almacen-rutas-hoy button')).some((b) => (b.textContent ?? '').includes('Reintentar'))).toBe(true);
  });

  it('[MCP.3.6] con una ruta lista, va arriba y los de abajo se rotulan «Pedidos sueltos»', async () => {
    pv.routes = vi.fn(() => of({ today: '2026-10-19', scope: 'propios', data: [{
      route_day_id: 'rd-1', kind: 'ruta', seller_name: 'Vendedora Prueba', work_date: '2026-10-19', state: 'lista',
      started_at: '2026-10-19T14:00:00.000Z', finished_at: '2026-10-19T20:10:00.000Z', orders: 4, products: 18,
      pick_started: null, pick_finished: null,
    }] }));
    await montar();
    clic('Sucursal');
    const t = texto();
    expect(t).toContain('Ruta de Vendedora Prueba');
    expect(t).toContain('Pedidos sueltos');
    expect(t.indexOf('Ruta de Vendedora Prueba')).toBeLessThan(t.indexOf('ABARROTES ROSY'));
  });

  it('[MCP.3.6] sin rutas hoy no se pinta nada de rutas (ni «Pedidos sueltos»)', async () => {
    await montar();
    clic('Sucursal');
    expect(texto()).not.toContain('Rutas de hoy');
    expect(texto()).not.toContain('Pedidos sueltos');
    expect(texto()).toContain('ABARROTES ROSY');
  });
});
