import { conteosDeVisitas, habiles, metaDelPeriodo, visitasDelPeriodo, type PedidoLevantado, type VisitaCruda } from './vecinal-vendors.engine';

/**
 * `[MV.2]` Monitoreo vecinal — vendedores, sin base: la meta del periodo, cómo se arma cada visita con
 * lo levantado y lo cobrado, y los conteos de la fila.
 */
describe('metaDelPeriodo · la meta en proporción a los días con actividad', () => {
  // La catorcena (ancla 2026-10-17) del 31-oct (sábado) al 13-nov (viernes): 12 días con actividad.
  const metas = [{ period_start: '2026-10-31', amount: 12000 }];
  it('la catorcena entera es su meta', () => {
    expect(metaDelPeriodo(metas, '2026-10-31', '2026-11-13')).toBe(12000);
  });
  it('un día con actividad es 1/12 de la meta', () => {
    expect(metaDelPeriodo(metas, '2026-11-05', '2026-11-05')).toBe(1000);
  });
  it('el domingo no suma meta (no hay reparto)', () => {
    expect(metaDelPeriodo(metas, '2026-11-01', '2026-11-01')).toBe(0);
  });
  it('dos catorcenas: cada parte con su meta', () => {
    const dos = [...metas, { period_start: '2026-11-14', amount: 24000 }];
    // 12 y 13 de nov (2 de 12 días de la primera) + 14 y 16 (2 de 12 de la segunda; el 15 es domingo).
    expect(metaDelPeriodo(dos, '2026-11-12', '2026-11-16')).toBe(2000 + 4000);
  });
  it('⭐ si una catorcena del periodo no tiene meta, la del periodo es null (no una meta menor)', () => {
    expect(metaDelPeriodo(metas, '2026-11-12', '2026-11-16')).toBeNull();
    expect(metaDelPeriodo([], '2026-11-05', '2026-11-05')).toBeNull();
  });
  it('días con actividad: lunes a sábado', () => {
    expect(habiles('2026-11-01', '2026-11-07')).toBe(6);
  });
});

const ap = (p: Partial<VisitaCruda>): VisitaCruda => ({
  customer_id: 'c1', customer_code: 'C1', customer_name: 'Tienda Prueba Uno', date: '2026-11-05',
  visited_at: '2026-11-05T15:00:00.000Z', ended_at: '2026-11-05T15:07:00.000Z', had_order: false,
  no_sale_reason: null, notes: null, latitude: 20.3, longitude: -102.0, ...p,
});
const ped = (p: Partial<PedidoLevantado>): PedidoLevantado => ({
  order_id: 'o1', code: 'PD-1', customer_id: 'c1', customer_code: 'C1', customer_name: 'Tienda Prueba Uno', date: '2026-11-05',
  created_at: '2026-11-05T15:05:00.000Z', total: 640, lines: [{ product_name: 'PALETA', sku: '100', unit: 'CJA', quantity: 2, line_total: 456 }], ...p,
});

describe('visitasDelPeriodo · cada visita con lo levantado y lo cobrado', () => {
  it('⭐ junta la visita con su pedido del mismo día y lo que Kepler le cobró a ese cliente', () => {
    const [v] = visitasDelPeriodo([ap({})], [ped({})], new Map([['c1|2026-11-05', 612.5]]));
    expect(v).toMatchObject({ status: 'con_pedido', minutes: 7, ordered_total: 640, charged: 612.5, customer_name: 'Tienda Prueba Uno' });
    expect(v.orders[0].lines[0]).toMatchObject({ product_name: 'PALETA', quantity: 2, unit: 'CJA' });
  });
  it('sin fuente de Kepler, lo cobrado es null (no 0); medida y sin venta, 0', () => {
    expect(visitasDelPeriodo([ap({})], [], null)[0].charged).toBeNull();
    expect(visitasDelPeriodo([ap({})], [], new Map())[0].charged).toBe(0);
  });
  it('dos aperturas del mismo cliente el mismo día son UNA visita: primera llegada, último cierre', () => {
    const vs = visitasDelPeriodo([
      ap({ visited_at: '2026-11-05T15:00:00.000Z', ended_at: '2026-11-05T15:02:00.000Z' }),
      ap({ visited_at: '2026-11-05T16:00:00.000Z', ended_at: '2026-11-05T16:10:00.000Z', no_sale_reason: 'cerrado' }),
    ], [], null);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ visited_at: '2026-11-05T15:00:00.000Z', ended_at: '2026-11-05T16:10:00.000Z', minutes: 70, status: 'sin_pedido', no_sale_reason: 'cerrado' });
  });
  it('una visita sin cerrar es «abierta» y su tiempo no se inventa', () => {
    const [v] = visitasDelPeriodo([ap({ ended_at: null })], [], null);
    expect(v).toMatchObject({ status: 'abierta', minutes: null, ended_at: null });
  });
  it('un pedido sin visita abierta también sale («sin_visita»)', () => {
    const [v] = visitasDelPeriodo([], [ped({ customer_id: 'c9', customer_name: 'Tienda Prueba Dos' })], null);
    expect(v).toMatchObject({ status: 'sin_visita', visited_at: null, customer_name: 'Tienda Prueba Dos', ordered_total: 640 });
  });
  it('venta directa marcada en la visita (had_order) cuenta como con pedido aunque no haya pedido en la app', () => {
    expect(visitasDelPeriodo([ap({ had_order: true })], [], null)[0].status).toBe('con_pedido');
  });
  it('el pedido de OTRO día no se pega a la visita', () => {
    const vs = visitasDelPeriodo([ap({})], [ped({ date: '2026-11-04', created_at: '2026-11-04T15:00:00.000Z' })], null);
    expect(vs.map((v) => v.status).sort()).toEqual(['sin_pedido', 'sin_visita']);
  });
  it('de la más nueva a la más vieja', () => {
    const vs = visitasDelPeriodo([ap({ customer_id: 'a', visited_at: '2026-11-05T14:00:00.000Z' }), ap({ customer_id: 'b', visited_at: '2026-11-05T17:00:00.000Z' })], [], null);
    expect(vs.map((v) => v.customer_id)).toEqual(['b', 'a']);
  });
});

describe('conteosDeVisitas', () => {
  it('cuenta con pedido, sin pedido con y sin motivo, abiertas, y promedia sólo las cerradas', () => {
    const vs = visitasDelPeriodo([
      ap({ customer_id: 'a' }),
      ap({ customer_id: 'b', no_sale_reason: 'cerrado', ended_at: '2026-11-05T15:03:00.000Z' }),
      ap({ customer_id: 'c', ended_at: '2026-11-05T15:11:00.000Z' }),
      ap({ customer_id: 'd', ended_at: null }),
    ], [ped({ customer_id: 'a' })], null);
    expect(conteosDeVisitas(vs)).toEqual({
      visits: 4, with_order: 1, no_sale_with_reason: 1, no_sale_without_reason: 1, open_visits: 1,
      avg_visit_minutes: Math.round((7 + 3 + 11) / 3), orders: 1, ordered_total: 640,
    });
  });
});
