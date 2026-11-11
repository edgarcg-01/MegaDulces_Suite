import type { PresaleSellerOrder, VisitMonitorRow, VisitMonitorVendor } from '@megadulces/contracts';
import { armarRecuento, cuantoBajo, estadoDeSurtido, juntarPartes, visitasDelDia, type EntradaRecuento, type FilaPedidoDelDia } from './recuento-dia.engine';

const HOY = '2026-11-10';
const fila = (id: string, x: Partial<FilaPedidoDelDia> = {}): FilaPedidoDelDia => ({
  id, code: `PD-${id}`, customer_id: `c-${id}`, customer_name: `Cliente ${id}`, status: 'confirmed', total: '100.00',
  created_at: `${HOY}T15:00:00.000Z`, group_id: null, cancellation_reason: null, ...x,
});
const persona = { user_id: 'u', name: 'Surtidor', at: `${HOY}T16:00:00.000Z` };
const avance = (id: string, x: Partial<PresaleSellerOrder> = {}): PresaleSellerOrder => ({
  order_id: id, code: `PD-${id}`, customer_name: null, requested_delivery_date: HOY, total: 100, lines: 2, status: 'confirmed',
  scheduled_at: null, warehouse_name: null, started: null, finished: null, report: null, review: null, reviewed: null,
  charge: null, delivered_at: null, report_unseen: false, ...x,
});
const terminado = (outcome: 'completo' | 'con_faltantes') => ({ started: persona, finished: { ...persona, outcome } });
const entrada = (x: Partial<EntradaRecuento> = {}): EntradaRecuento => ({
  fecha: HOY, hoy: HOY, userId: 'v', nombre: 'Vendedora', pedidos: [], avance: [], avanceError: null, visitas: null, visitasError: null, ...x,
});
const renglon = (customer_id: string, status: VisitMonitorRow['status'], x: Partial<VisitMonitorRow> = {}): VisitMonitorRow => ({
  customer_id, code: customer_id.toUpperCase(), name: `Tienda ${customer_id}`, on_route: true, has_location: true, status,
  no_sale_reason: null, notes: null, visited_at: null, ended_at: null, distance_m: null, far: false, nearest_m: null, ...x,
});
const dia = (rows: VisitMonitorRow[], closed = false): VisitMonitorVendor => ({
  user_id: 'v', name: 'Vendedora', routes: ['RUTA 27'], route_source: 'agenda', day_state: 'en_ruta', started_at: null, finished_at: null,
  closed, gps_points: 0, gps_first_at: null, gps_last_at: null, counts: {} as VisitMonitorVendor['counts'], rows,
});

describe('[MCP.19] recuento del día', () => {
  it('levantado = ni borrador ni cancelado; la lista del desglose suma lo mismo que el número', () => {
    const r = armarRecuento(entrada({
      pedidos: [fila('a', { total: '120.50' }), fila('b', { total: 80 }), fila('c', { status: 'draft', total: 999 }),
        fila('d', { status: 'cancelled', total: 500, cancellation_reason: 'Pedido duplicado' }), fila('e', { status: 'pending_approval', total: 40 })],
      avance: [avance('a'), avance('b')],
    }));
    expect(r.orders).toEqual({ count: 3, total: 240.5 });
    expect(r.orders_list.map((o) => o.order_id)).toEqual(['a', 'b', 'e']);
    expect(r.orders_list.reduce((s, o) => s + o.total, 0)).toBe(r.orders.total);
    expect(r.pending.drafts.map((o) => o.order_id)).toEqual(['c']);
    expect(r.pending.awaiting_approval.map((o) => o.order_id)).toEqual(['e']);
    expect(r.cancelled).toEqual([expect.objectContaining({ order_id: 'd', reason: 'Pedido duplicado' })]);
  });

  it('cancelado sin motivo dice null (la pantalla dice «sin motivo»), no inventa uno', () => {
    const r = armarRecuento(entrada({ pedidos: [fila('d', { status: 'cancelled', cancellation_reason: '  ' })] }));
    expect(r.cancelled[0].reason).toBeNull();
  });

  it('qué pasó al surtir: cada estado, lo que bajó, lo cobrado y lo entregado', () => {
    const r = armarRecuento(entrada({
      pedidos: ['a', 'b', 'c', 'd'].map((id) => fila(id)),
      avance: [
        avance('a', { ...terminado('completo'), charge: { source: 'liga', folio_digital: 'F1', fecha: HOY, total: 100, shared_products: 2, order_products: 2 }, delivered_at: `${HOY}T20:00:00Z` }),
        avance('b', { ...terminado('con_faltantes'), report: { removed: [], adjusted: [], total_before: 100, total_after: 70.25 },
          charge: { source: 'detectado', folio_digital: 'F2', fecha: HOY, total: 70.25, shared_products: 1, order_products: 2 } }),
        avance('c', { started: persona }),
        avance('d'),
      ],
    }));
    expect(r.picking).toEqual({ completo: 1, con_faltantes: 1, surtiendo: 1, sin_surtir: 1, sin_dato: 0, removed_total: 29.75, charged: 1, charged_to_confirm: 1, delivered: 1 });
  });

  it('un pedido sin su fila de avance es «sin dato», no «sin surtir» (no se adivina)', () => {
    const r = armarRecuento(entrada({ pedidos: [fila('a'), fila('b')], avance: [avance('a')] }));
    expect(r.picking?.sin_dato).toBe(1);
    expect(r.picking?.sin_surtir).toBe(1);
  });

  it('si el surtido no se pudo leer, se declara (null + motivo) y los levantados siguen contando', () => {
    const r = armarRecuento(entrada({ pedidos: [fila('a')], avance: null, avanceError: 'No se pudo leer el surtido.' }));
    expect(r.picking).toBeNull();
    expect(r.picking_unmeasured_reason).toBe('No se pudo leer el surtido.');
    expect(r.orders.count).toBe(1);
    expect(r.orders_list[0].pick).toBe('sin_dato');
  });

  it('sin visitas se declara con su motivo; nunca 0 de 0', () => {
    const r = armarRecuento(entrada({ visitasError: 'Sin ruta ni visitas ese día.' }));
    expect(r.visits).toBeNull();
    expect(r.visits_unmeasured_reason).toBe('Sin ruta ni visitas ese día.');
  });

  it('día vacío: cero levantados es cero medido (con surtido leído), no un hueco', () => {
    const r = armarRecuento(entrada());
    expect(r.orders).toEqual({ count: 0, total: 0 });
    expect(r.picking).toEqual(expect.objectContaining({ completo: 0, sin_surtir: 0, sin_dato: 0 }));
  });

  it('[MCP.3.14] un pedido que surten dos sucursales cuenta como UNO, con la suma y el estado de la parte más atrasada', () => {
    const r = armarRecuento(entrada({
      pedidos: [fila('m', { group_id: 'm', total: 60 }), fila('p', { group_id: 'm', total: 40, created_at: `${HOY}T15:00:01.000Z` })],
      avance: [avance('m', terminado('completo')), avance('p', terminado('con_faltantes'))],
    }));
    expect(r.orders).toEqual({ count: 1, total: 100 });
    expect(r.orders_list[0]).toEqual(expect.objectContaining({ order_id: 'm', pick: 'con_faltantes' }));
  });

  it('juntarPartes: cobrado o entregado sólo si lo están todas', () => {
    const base = armarRecuento(entrada({ pedidos: [fila('x')], avance: [avance('x')] })).orders_list[0];
    const j = juntarPartes([{ ...base, charge: 'liga', delivered: true }, { ...base, order_id: 'y', charge: null, delivered: false }]);
    expect(j.charge).toBeNull();
    expect(j.delivered).toBe(false);
    expect(juntarPartes([{ ...base, charge: 'liga' }, { ...base, charge: 'detectado' }]).charge).toBe('detectado');
  });

  it('estadoDeSurtido: lo que no llegó a la mesa (por aprobar) es «sin surtir»', () => {
    expect(estadoDeSurtido('pending_approval', undefined, true)).toBe('sin_surtir');
    expect(estadoDeSurtido('confirmed', undefined, false)).toBe('sin_dato');
  });

  it('cuantoBajo: con la caja manda cómo quedó en caja; si la caja completó de más, no da negativo', () => {
    const conCaja = avance('a', { ...terminado('con_faltantes'), report: { removed: [], adjusted: [], total_before: 100, total_after: 60 },
      review: { total_before: 60, total_after: 80 } as PresaleSellerOrder['review'] });
    expect(cuantoBajo(conCaja, 100)).toBe(20);
    const completoDeMas = avance('b', { ...terminado('completo'), review: { total_before: 100, total_after: 130 } as PresaleSellerOrder['review'] });
    expect(cuantoBajo(completoDeMas, 100)).toBe(0);
    expect(cuantoBajo(avance('c'), 100)).toBe(0);
  });

  it('visitas: de su ruta contra fuera de ruta, faltas contra pendientes, y los motivos de no venta', () => {
    const v = visitasDelDia(dia([
      renglon('a', 'con_pedido'), renglon('b', 'sin_pedido', { no_sale_reason: 'cerrado' }), renglon('c', 'sin_pedido', { no_sale_reason: 'cerrado' }),
      renglon('d', 'sin_pedido'), renglon('e', 'abierta'), renglon('f', 'no_paso'), renglon('g', 'pendiente'),
      renglon('h', 'con_pedido', { on_route: false }),
    ]));
    expect(v).toEqual(expect.objectContaining({
      route_customers: 7, visited: 6, visited_on_route: 5, off_route: 1, with_order: 2, without_order: 3, open: 1, missed: 1, pending: 1,
    }));
    expect(v.visited).toBe(v.visited_on_route + v.off_route);
    expect(v.not_visited.map((c) => [c.customer_id, c.state])).toEqual([['f', 'no_paso'], ['g', 'pendiente']]);
    expect(v.no_sale_reasons).toEqual([{ reason: 'cerrado', count: 2 }, { reason: 'sin_motivo', count: 1 }]);
  });

  it('el nombre sale de la persona y, si no está, del monitoreo', () => {
    expect(armarRecuento(entrada({ nombre: null, visitas: dia([]) })).name).toBe('Vendedora');
  });
});
