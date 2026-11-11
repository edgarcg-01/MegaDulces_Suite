import { RouteDayService } from '../route-day.service';
/**
 * `[MCP.19]` Recuento del día del vendedor: las frases, el componente que comparten el vendedor y su
 * supervisor, y cómo vive arriba de «Pedidos» (con lo que antes estaba en «Mi día»: la cola del celular
 * y «Llevar pedidos»). Lo que importa: que cada número se pueda abrir, que lo no medido se diga y no se
 * pinte en cero, y que tocar algo siempre responda.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ConfirmationService, MessageService } from 'primeng/api';
import { of, throwError } from 'rxjs';
import type { PresaleSellerOrder, SellerDayOrder, SellerDayRecap, SellerDayVisits } from '@megadulces/contracts';
import { VendorRecuentoDiaComponent } from '../components/recuento-dia.component';
import { VendorMisPedidosComponent } from './vendor-mis-pedidos.component';
import { PresaleStatusService } from '../presale-status.service';
import { VendorService } from '../vendor.service';
import { RecuentoDiaService } from '../recuento-dia.service';
import { OfflineOrderService, type PendingOrderSummary } from '../../../core/services/offline-order.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { estadoCliente, filasSurtido, fraseLevantado, fraseResultadoVisitas, fraseVisitas, pedidosDeFila, resumenSurtido, tituloDelDia } from '../recuento-dia';
import { appRoutes } from '../../../app.routes';

const txt = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const pedido = (id: string, p: Partial<SellerDayOrder> = {}): SellerDayOrder => ({
  order_id: id, code: `PD-${id}`, customer_id: `c-${id}`, customer_name: `Tienda ${id}`, total: 100, created_at: '2026-11-10T15:00:00.000Z',
  status: 'confirmed', pick: 'sin_surtir', removed_total: 0, charge: null, delivered: false, reason: null, ...p,
});
const visitas = (v: Partial<SellerDayVisits> = {}): SellerDayVisits => ({
  route_customers: 12, routes: ['RUTA 27'], visited: 10, visited_on_route: 9, off_route: 1, with_order: 7, without_order: 2, open: 1,
  missed: 1, pending: 2, closed: false, not_visited: [{ customer_id: 'n1', code: 'N-1', name: 'Tienda Lejos', state: 'pendiente' }],
  no_sale_reasons: [{ reason: 'cerrado', count: 1 }, { reason: 'sin_motivo', count: 1 }], ...v,
});
const recuento = (r: Partial<SellerDayRecap> = {}): SellerDayRecap => ({
  date: '2026-11-10', today: '2026-11-10', user_id: 'v', name: 'Vendedora',
  orders: { count: 3, total: 320 },
  picking: { completo: 1, con_faltantes: 1, surtiendo: 0, sin_surtir: 1, sin_dato: 0, removed_total: 40, charged: 1, charged_to_confirm: 1, delivered: 0 },
  picking_unmeasured_reason: null,
  visits: visitas(), visits_unmeasured_reason: null,
  pending: { drafts: [pedido('b', { status: 'draft', total: 55 })], awaiting_approval: [] },
  cancelled: [pedido('x', { status: 'cancelled', reason: null })],
  orders_list: [
    pedido('a', { pick: 'completo', charge: 'liga' }),
    pedido('f', { pick: 'con_faltantes', total: 120, removed_total: 40, charge: 'detectado' }),
    pedido('s', { total: 100 }),
  ],
  ...r,
});

describe('[MCP.19] frases del recuento', () => {
  it('levantado: propio y del supervisor, con y sin pedidos, hoy y otro día', () => {
    expect(fraseLevantado(recuento(), true)).toBe('Levantaste 3 pedidos');
    expect(fraseLevantado(recuento({ orders: { count: 1, total: 10 } }), false)).toBe('Levantó 1 pedido');
    expect(fraseLevantado(recuento({ orders: { count: 0, total: 0 } }), true)).toBe('Todavía no levantas pedidos hoy.');
    expect(fraseLevantado(recuento({ orders: { count: 0, total: 0 }, date: '2026-11-09' }), false)).toBe('No levantó pedidos ese día.');
  });

  it('visitas: de su ruta, fuera de ella y sin ruta', () => {
    expect(fraseVisitas(visitas(), true)).toBe('Visitaste 9 de 12 clientes de tu ruta y 1 fuera de ella');
    expect(fraseVisitas(visitas({ off_route: 0 }), false)).toBe('Visitó 9 de 12 clientes de su ruta');
    expect(fraseVisitas(visitas({ route_customers: 0, visited: 3 }), true)).toBe('Sin ruta asignada · visitaste 3 clientes');
  });

  it('resultado: con pedido, sin venta con sus motivos en palabras, y visitas sin cerrar', () => {
    expect(fraseResultadoVisitas(visitas())).toBe('7 con pedido · 2 sin venta (1 estaba cerrado, 1 sin motivo) · 1 visita sin cerrar');
  });

  it('surtido: sólo las filas con algo; lo que bajó y lo «por confirmar» se dicen', () => {
    const fs = filasSurtido(recuento());
    expect(fs.map((f) => f.clave)).toEqual(['completo', 'con_faltantes', 'sin_surtir', 'cobrados']);
    expect(fs.find((f) => f.clave === 'con_faltantes')?.detalle).toBe('se quitaron $40.00');
    expect(fs.find((f) => f.clave === 'cobrados')).toEqual(expect.objectContaining({ n: 2, detalle: '1 por confirmar' }));
    expect(filasSurtido(recuento({ picking: null }))).toEqual([]);
  });

  it('[MCP.21] el surtido en una línea: singular y plural, lo que bajó, y sólo estados que suman los pedidos', () => {
    const r = recuento();
    expect(resumenSurtido(r)).toBe('1 surtido completo · 1 con faltantes (−$40.00) · 1 espera al surtidor');
    // Control: los números de la línea suman los pedidos del día (cobrados y entregados se cruzan con ellos: van aparte).
    const suma = (resumenSurtido(r).match(/\d+(?= )/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
    expect(suma).toBe(r.orders.count);
    expect(resumenSurtido(recuento({ picking: { completo: 0, con_faltantes: 0, surtiendo: 2, sin_surtir: 3, sin_dato: 0, removed_total: 0, charged: 0, charged_to_confirm: 0, delivered: 0 } })))
      .toBe('2 surtiéndose · 3 esperan al surtidor');
    expect(resumenSurtido(recuento({ picking: null }))).toBe('');
  });

  it('cada fila abre exactamente los pedidos que cuenta', () => {
    const r = recuento();
    for (const f of filasSurtido(r)) expect(pedidosDeFila(r, f.clave)).toHaveLength(f.n);
  });

  it('el cliente sin visita dice por qué; el título dice «Hoy» o el día', () => {
    expect(estadoCliente({ customer_id: 'n', code: 'N', name: 'N', state: 'no_paso' }, true)).toBe('No pasaste');
    expect(estadoCliente({ customer_id: 'n', code: 'N', name: 'N', state: 'se_fue_sin_abrir' }, false)).toBe('Pasó y no lo abrió');
    expect(tituloDelDia(recuento())).toBe('Hoy');
    expect(tituloDelDia(recuento({ date: '2026-11-09' }))).toBe('Lunes, 9 de noviembre');
  });
});

describe('[MCP.19] el componente del recuento', () => {
  let fix: ComponentFixture<VendorRecuentoDiaComponent>;
  const el = (): HTMLElement => fix.nativeElement as HTMLElement;
  const boton = (t: string) => Array.from(el().querySelectorAll('button')).find((b) => txt(b).includes(t)) as HTMLButtonElement | undefined;

  async function montar(entradas: Record<string, unknown>) {
    await TestBed.configureTestingModule({ imports: [VendorRecuentoDiaComponent] }).compileComponents();
    fix = TestBed.createComponent(VendorRecuentoDiaComponent);
    for (const [k, v] of Object.entries(entradas)) fix.componentRef.setInput(k, v);
    fix.detectChanges();
  }
  afterEach(() => TestBed.resetTestingModule());

  it('primero la respuesta: hoy, cuánto levantó y a quién visitó', async () => {
    await montar({ recuento: recuento(), estado: 'listo' });
    const t = txt(el());
    expect(t).toContain('Hoy');
    expect(t).toContain('Levantaste 3 pedidos');
    expect(t).toContain('$320.00');
    expect(t).toContain('Visitaste 9 de 12 clientes de tu ruta');
    expect(t.indexOf('Levantaste')).toBeLessThan(t.indexOf('Cómo van al surtir'));
    expect(t.indexOf('Cómo van al surtir')).toBeLessThan(t.indexOf('Pendiente'));
  });

  it('cada número se abre: «con faltantes» lista su pedido con lo que bajó, y tocarlo avisa cuál', async () => {
    await montar({ recuento: recuento(), estado: 'listo', pedidosAbribles: true });
    const abiertos: string[] = [];
    fix.componentInstance.abrirPedido.subscribe((id) => abiertos.push(id));
    const fila = boton('Surtidos con faltantes') as HTMLButtonElement;
    expect(fila.getAttribute('aria-expanded')).toBe('false');
    fila.click();
    fix.detectChanges();
    expect(fila.getAttribute('aria-expanded')).toBe('true');
    expect(txt(el())).toContain('Tienda f');
    expect(txt(el())).toContain('$120.00 · −$40.00');
    (boton('Tienda f') as HTMLButtonElement).click();
    expect(abiertos).toEqual(['f']);
  });

  it('donde no hay lista que abrir (supervisor), el pedido del desglose no es botón', async () => {
    await montar({ recuento: recuento(), estado: 'listo', propio: false });
    (boton('Surtidos completos') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(txt(el())).toContain('Tienda a');
    expect(boton('Tienda a')).toBeUndefined();
  });

  it('lo no medido se dice con su motivo, no con ceros', async () => {
    await montar({ recuento: recuento({ picking: null, picking_unmeasured_reason: 'No se pudo leer el surtido.', visits: null, visits_unmeasured_reason: 'Sin ruta ni visitas ese día.' }), estado: 'listo' });
    const t = txt(el());
    expect(t).toContain('No se pudo leer el surtido.');
    expect(t).toContain('Visitas: Sin ruta ni visitas ese día.');
    expect(t).not.toContain('Surtidos completos');
    expect(t).not.toContain('Visitaste 0');
  });

  it('lo pendiente: el borrador se abre para mandarlo; el cancelado sin motivo lo dice', async () => {
    await montar({ recuento: recuento(), estado: 'listo' });
    const borradores: string[] = [];
    fix.componentInstance.abrirBorrador.subscribe((c) => borradores.push(c));
    (boton('Borradores sin mandar') as HTMLButtonElement).click();
    fix.detectChanges();
    (boton('Abrir para mandarlo') as HTMLButtonElement).click();
    expect(borradores).toEqual(['c-b']);
    (boton('Cancelados') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(txt(el())).toContain('Motivo: sin motivo registrado');
    (boton('sin visita') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(txt(el())).toContain('Tienda Lejos');
    expect(txt(el())).toContain('Por visitar');
  });

  it('el supervisor lo lee en tercera persona, sin la línea de visitas ni los clientes (ya los tiene en su pantalla)', async () => {
    await montar({ recuento: recuento(), estado: 'listo', propio: false, conVisitas: false, conClientes: false });
    const t = txt(el());
    expect(t).toContain('Levantó 3 pedidos');
    expect(t).not.toContain('Visitó');
    expect(t).not.toContain('sin visita');
  });

  it('cargando y error son distintos, y el error se puede reintentar', async () => {
    await montar({ recuento: null, estado: 'cargando' });
    expect(txt(el())).toContain('Cargando el recuento del día');
    fix.componentRef.setInput('estado', 'error');
    fix.componentRef.setInput('error', 'Sin señal.');
    fix.detectChanges();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    let reintentos = 0;
    fix.componentInstance.reintentar.subscribe(() => reintentos++);
    (boton('Reintentar') as HTMLButtonElement).click();
    expect(reintentos).toBe(1);
  });
});

describe('[MCP.19] el recuento arriba de «Pedidos»', () => {
  afterEach(() => TestBed.resetTestingModule());

  const enLista = (id: string): PresaleSellerOrder => ({
    order_id: id, code: `PD-${id}`, customer_name: `Tienda ${id}`, requested_delivery_date: '2026-11-10', total: 100, lines: 1, status: 'confirmed',
    scheduled_at: null, warehouse_name: null, started: null, finished: null, report: null, charge: null, delivered_at: null, report_unseen: false,
  });

  async function montar(o: { cola?: PendingOrderSummary[]; puedeLlevar?: boolean; recuentoFalla?: boolean } = {}) {
    const dia = vi.fn(() => (o.recuentoFalla ? throwError(() => ({ error: { message: 'Sin señal.' } })) : of(recuento())));
    const offline = {
      pendingSummaries: vi.fn(() => Promise.resolve(o.cola ?? [])),
      retry: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(() => Promise.resolve()),
    };
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    await TestBed.configureTestingModule({
      imports: [VendorMisPedidosComponent],
      providers: [
        { provide: PresaleStatusService, useValue: { status: vi.fn(() => of({ today: '2026-11-10', data: [enLista('a'), enLista('s')], unseen_reports: 0 })), markSeen: vi.fn(), unseen: vi.fn() } },
        { provide: VendorService, useValue: { orderById: vi.fn(() => of({ id: 'a', lines: [] })) } },
        { provide: RecuentoDiaService, useValue: { dia } },
        { provide: OfflineOrderService, useValue: offline },
        // [MCP.21] Corregir/cancelar avisan con el toast; «Terminar mi día» lee la ruta del día.
        { provide: MessageService, useValue: { add: vi.fn() } },
        { provide: RouteDayService, useValue: { today: vi.fn(() => of({ state: 'sin_iniciar' })) } },
        { provide: PermissionsService, useValue: { has: () => false, hasAny: () => !!o.puedeLlevar } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(VendorMisPedidosComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    const boton = (t: string) => Array.from(el.querySelectorAll('button')).find((b) => txt(b).includes(t)) as HTMLButtonElement | undefined;
    return { fix, el, dia, offline, boton };
  }

  it('al entrar pide su recuento (el suyo: sin persona, del día que dice el servidor) y lo pone arriba de la lista', async () => {
    const { el, dia } = await montar();
    // [MCP.20] Del día en pantalla: hoy según el servidor (el reloj del equipo de pruebas no manda).
    expect(dia).toHaveBeenLastCalledWith('2026-11-10');
    const t = txt(el);
    expect(t).toContain('Levantaste 3 pedidos');
    expect(t.indexOf('Levantaste')).toBeLessThan(t.indexOf('Pedidos que levantaste'));
  });

  it('del recuento a la tarjeta: tocar un pedido lo abre en la lista; si ya no está, lo dice', async () => {
    const { fix, el, boton } = await montar();
    (boton('Ver detalle') as HTMLButtonElement).click();
    fix.detectChanges();
    (boton('Surtidos completos') as HTMLButtonElement).click();
    fix.detectChanges();
    (boton('Tienda a') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(el.querySelector('#mp-a .mp-card-h')?.getAttribute('aria-expanded')).toBe('true');
    (boton('Surtidos con faltantes') as HTMLButtonElement).click();
    fix.detectChanges();
    (boton('Tienda f') as HTMLButtonElement).click();
    fix.detectChanges();
    expect(txt(el)).toContain('Ese pedido ya no está en la lista de abajo');
  });

  it('si el recuento falla, la lista se ve igual y el recuento se puede reintentar', async () => {
    const { el, dia, boton } = await montar({ recuentoFalla: true });
    expect(txt(el)).toContain('Sin señal.');
    expect(txt(el)).toContain('Tienda a');
    const antes = dia.mock.calls.length;
    (Array.from(el.querySelectorAll('app-vendor-recuento-dia button')).find((b) => txt(b) === 'Reintentar') as HTMLButtonElement).click();
    expect(dia.mock.calls.length).toBe(antes + 1);
    expect(boton('Reintentar')).toBeDefined();
  });

  it('lo que se quedó en el celular va arriba: reintentar el que no se pudo enviar y descartarlo con confirmación', async () => {
    const cola: PendingOrderSummary[] = [{ id: 'q1', customerName: 'Tienda Sin Señal', total: 250, units: 4, intentos: 5, dead: true, createdAt: '2026-11-10T15:00:00.000Z' } as PendingOrderSummary];
    const { fix, el, offline, boton } = await montar({ cola });
    expect(txt(el)).toContain('Sin enviar · 1');
    expect(txt(el)).toContain('Tienda Sin Señal');
    expect(txt(el).indexOf('Sin enviar')).toBeLessThan(txt(el).indexOf('Levantaste'));
    (boton('Reintentar') as HTMLButtonElement).click();
    expect(offline.retry).toHaveBeenCalledWith('q1');
    const confirmar = vi.spyOn(fix.debugElement.injector.get(ConfirmationService), 'confirm');
    (el.querySelector('[aria-label="Descartar el pedido de Tienda Sin Señal"]') as HTMLButtonElement).click();
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(offline.cancel).not.toHaveBeenCalled();
    (confirmar.mock.calls[0][0] as { accept: () => void }).accept();
    expect(offline.cancel).toHaveBeenCalledWith('q1');
  });

  it('«Llevar pedidos» (antes en «Mi día») sólo con permiso de repartir o entregar', async () => {
    const sin = await montar();
    expect(txt(sin.el)).not.toContain('Llevar pedidos');
    TestBed.resetTestingModule();
    const con = await montar({ puedeLlevar: true });
    expect(con.el.querySelector('a.mp-llevar')?.getAttribute('href')).toBe('/vendor/llevar');
  });

  it('⭐ [MCP.21] en «Pedidos», tres renglones: cuánto, cómo va el surtido y a quién visitó; lo demás en «Ver detalle»', async () => {
    const { fix, el, boton } = await montar();
    const rd = () => txt(el.querySelector('app-vendor-recuento-dia'));
    expect(rd()).toContain('Levantaste 3 pedidos');
    expect(rd()).toContain('1 surtido completo · 1 con faltantes (−$40.00) · 1 espera al surtidor');
    expect(rd()).toContain('Visitaste 9 de 12 clientes de tu ruta');
    expect(rd()).toContain('1 borrador sin mandar');
    // Lo que ya dicen la lista de abajo y «Mi ruta» no se repite hasta pedirlo.
    expect(rd()).not.toContain('Cómo van al surtir');
    expect(rd()).not.toContain('Clientes de tu ruta sin visita');
    expect(rd()).not.toContain('Cancelados');
    // «Hoy» lo dice el chip de arriba: el título queda para el lector de pantalla, no a la vista.
    expect(el.querySelector('app-vendor-recuento-dia h2')?.classList.contains('rd-oculto')).toBe(true);
    const ver = boton('Ver detalle') as HTMLButtonElement;
    expect(ver.getAttribute('aria-expanded')).toBe('false');
    ver.click();
    fix.detectChanges();
    expect(rd()).toContain('Cómo van al surtir');
    expect(rd()).toContain('Clientes de tu ruta sin visita');
    expect(rd()).toContain('Cancelados');
    expect(boton('Ocultar detalle')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('[MCP.21] «Terminar mi día» y «Llevar pedidos» van en una sola fila, sin subtítulos', async () => {
    const { el } = await montar({ puedeLlevar: true });
    const fila = el.querySelector('.mp-acciones');
    expect(txt(fila)).toBe('Llevar pedidos');
    expect(txt(el)).not.toContain('Elige lo que te llevas para tu guía de carga');
  });

  it('un borrador del recuento abre «Tomar pedido» de ese cliente', async () => {
    const { fix, boton } = await montar();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    // [MCP.21] En «Pedidos» el borrador es un aviso: tocarlo abre el detalle con el borrador a la vista.
    (boton('1 borrador sin mandar') as HTMLButtonElement).click();
    fix.detectChanges();
    (boton('Abrir para mandarlo') as HTMLButtonElement).click();
    expect(nav).toHaveBeenCalledWith(['/vendor/take-order', 'c-b']);
  });
});

describe('[MCP.19] «Mi día» se juntó con «Pedidos»', () => {
  it('un enlace viejo a /vendor/today cae en «Pedidos», no en blanco', () => {
    const hijos = appRoutes.find((r) => r.path === 'vendor')?.children ?? [];
    expect(hijos.find((r) => r.path === 'today')).toEqual(expect.objectContaining({ redirectTo: 'mis-pedidos' }));
  });
});
