import type { VecinalVendorRow, VisitMonitorCounts, VisitMonitorRow, VisitMonitorVendor } from '@megadulces/contracts';
import {
  armarEquipo,
  avanceVisitas,
  diaAnterior,
  dineroDe,
  minutosVisita,
  motivoDeError,
  motivoNoVenta,
  ordenarClientes,
  prioridadDe,
  resumenEquipo,
  type Ventas,
} from './supervisor-equipo';

/** `[SUP.2]` Las reglas de «Mi equipo»: quién va primero y que el dinero que no se midió no se sume como cero. */
const cuentas = (c: Partial<VisitMonitorCounts> = {}): VisitMonitorCounts => ({
  clientes: 10, visitados: 0, con_pedido: 0, sin_pedido: 0, abiertas: 0, faltas: 0, se_fue_sin_abrir: 0, no_paso: 0,
  sin_ubicacion: 0, sin_gps: 0, pendientes: 0, lejos: 0, ...c,
});
const vendedor = (id: string, v: Partial<VisitMonitorVendor> = {}): VisitMonitorVendor => ({
  user_id: id, name: `Vendedor ${id}`, routes: ['RUTA 1'], route_source: 'agenda', day_state: 'en_ruta',
  started_at: '2026-11-06T14:00:00.000Z', finished_at: null, closed: false, gps_points: 20,
  gps_first_at: null, gps_last_at: null, counts: cuentas(), rows: [], ...v,
});
const fila = (id: string, r: Partial<VecinalVendorRow> = {}): VecinalVendorRow => ({
  user_id: id, name: `Vendedor ${id}`, routes: ['RUTA 1'], days_on_route: 1, day_state: 'en_ruta', route_started_at: null,
  route_finished_at: null, planned_customers: 10, visits: 3, with_order: 2, no_sale_with_reason: 1, no_sale_without_reason: 0,
  open_visits: 0, avg_visit_minutes: 8, orders: 2, ordered_total: 1000, charged: 800, charged_unmeasured_reason: null,
  target: 2000, progress_pct: 40, gps_points: 5, gps_last_at: null, first_at: null, last_at: null, ...r,
});
const ventas = (rows: VecinalVendorRow[]): Ventas => ({
  ok: true, data: { period: { from: '2026-11-06', to: '2026-11-06', days: 1 } as never, scope: 'propios', route_options: [], rows },
});

describe('supervisor-equipo · quién va primero', () => {
  it('faltas → sin iniciar (hoy) → abiertas → en ruta → terminó', () => {
    const vs = [
      vendedor('fin', { day_state: 'finalizada' }),
      vendedor('ruta'),
      vendedor('abiertas', { counts: cuentas({ abiertas: 2 }) }),
      vendedor('sin', { day_state: 'sin_iniciar', started_at: null }),
      vendedor('faltas', { counts: cuentas({ faltas: 2, se_fue_sin_abrir: 1, no_paso: 1 }) }),
    ];
    expect(armarEquipo(vs, null, true).map((f) => f.vendor.user_id)).toEqual(['faltas', 'sin', 'abiertas', 'ruta', 'fin']);
    expect(prioridadDe(vs[4], true).aviso).toBe('2 faltas: pasó y no abrió 1 · no pasó con 1');
  });

  it('un día pasado: «sin iniciar» ya no es urgente (no se arregla) pero se dice', () => {
    const v = vendedor('sin', { day_state: 'sin_iniciar' });
    expect(prioridadDe(v, false)).toEqual({ prioridad: 2, aviso: 'No inició la ruta ese día' });
  });

  it('en el mismo grupo va primero el que lleva menos avance; sin clientes no divide entre cero', () => {
    const lento = vendedor('lento', { counts: cuentas({ visitados: 2 }) });
    const rapido = vendedor('rapido', { counts: cuentas({ visitados: 8 }) });
    expect(armarEquipo([rapido, lento], null, true).map((f) => f.vendor.user_id)).toEqual(['lento', 'rapido']);
    expect(avanceVisitas(vendedor('x', { counts: cuentas({ clientes: 0 }) }))).toBeNull();
  });
});

describe('supervisor-equipo · el dinero', () => {
  it('une por usuario; si no está en ventas, su ruta no es vecinal', () => {
    const v = ventas([fila('a')]);
    expect(dineroDe('a', v)).toMatchObject({ estado: 'medido', levantado: 1000, cobrado: 800, avance: 40 });
    expect(dineroDe('b', v)).toEqual({ estado: 'no_vecinal' });
  });

  it('si la venta no se pudo leer se DECLARA, no se dibuja cero', () => {
    const r = resumenEquipo(armarEquipo([vendedor('a')], { ok: false, motivo: 'Sin conexión con el servidor.' }, true));
    expect(r.levantado).toBeNull();
    expect(r.cobrado).toBeNull();
    expect(r.cobrado_motivo).toBe('Sin conexión con el servidor.');
  });

  it('un solo vendedor sin cobro medido deja el cobrado del equipo sin medir (la suma saldría corta)', () => {
    const v = ventas([fila('a'), fila('b', { charged: null, charged_unmeasured_reason: 'Kepler no respondió.' })]);
    const r = resumenEquipo(armarEquipo([vendedor('a'), vendedor('b')], v, true));
    expect(r.levantado).toBe(2000);
    expect(r.cobrado).toBeNull();
    expect(r.cobrado_motivo).toBe('Kepler no respondió.');
  });

  it('con todo medido suma; cuenta quién empezó y las faltas', () => {
    const v = ventas([fila('a'), fila('b', { charged: 200 })]);
    const r = resumenEquipo(armarEquipo([
      vendedor('a', { counts: cuentas({ visitados: 3, con_pedido: 2, faltas: 1 }) }),
      vendedor('b', { day_state: 'sin_iniciar', counts: cuentas({ clientes: 5 }) }),
    ], v, true));
    expect(r).toMatchObject({ vendedores: 2, en_ruta: 1, sin_iniciar: 1, clientes: 15, visitados: 3, con_pedido: 2, faltas: 1, cobrado: 1000 });
  });
});

describe('supervisor-equipo · el detalle', () => {
  const cli = (id: string, r: Partial<VisitMonitorRow>): VisitMonitorRow => ({
    customer_id: id, code: id, name: `Cliente ${id}`, on_route: true, has_location: true, status: 'pendiente',
    no_sale_reason: null, notes: null, visited_at: null, ended_at: null, distance_m: null, far: false, nearest_m: null, ...r,
  });

  it('primero faltas, luego abiertas y por visitar; lo hecho al final por hora', () => {
    const rows = [
      cli('tarde', { status: 'con_pedido', visited_at: '2026-11-06T18:00:00Z' }),
      cli('temprano', { status: 'sin_pedido', visited_at: '2026-11-06T15:00:00Z' }),
      cli('pend', { status: 'pendiente' }),
      cli('abierta', { status: 'abierta', visited_at: '2026-11-06T16:00:00Z' }),
      cli('falta', { status: 'no_paso' }),
    ];
    expect(ordenarClientes(rows).map((r) => r.customer_id)).toEqual(['falta', 'abierta', 'pend', 'temprano', 'tarde']);
  });

  it('minutos sólo con la visita cerrada; motivo con el texto de la app', () => {
    expect(minutosVisita({ visited_at: '2026-11-06T15:00:00Z', ended_at: '2026-11-06T15:12:20Z' })).toBe(12);
    expect(minutosVisita({ visited_at: '2026-11-06T15:00:00Z', ended_at: null })).toBeNull();
    expect(motivoNoVenta('con_inventario')).toBe('Todavía tiene producto');
    expect(motivoNoVenta(null)).toBeNull();
  });

  it('fechas y errores', () => {
    expect(diaAnterior('2026-11-01')).toBe('2026-10-31');
    expect(diaAnterior('2027-01-01')).toBe('2026-12-31');
    expect(motivoDeError({ status: 403 }, 'x')).toBe('Tu usuario no tiene permiso para ver esto.');
    expect(motivoDeError({ status: 500, error: { message: 'Periodo inválido' } }, 'x')).toBe('Periodo inválido');
    expect(motivoDeError(null, 'genérico')).toBe('genérico');
  });
});
