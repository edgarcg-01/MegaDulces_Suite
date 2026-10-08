// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import { congelarPorPedido, presentacionDeProducto, type RenglonParaCongelar } from './congelar';

/**
 * `[GP.3]` Lo que se congela al arrancar la ola. Un error acá no revienta nada: el reparto del
 * cierre se calcularía contra cantidades equivocadas y un cliente recibiría de menos sin aviso.
 */
const r = (o: Partial<RenglonParaCongelar> & { order_id: string; product_id: string | null }): RenglonParaCongelar => ({
  order_code: `UD4001-${o.order_id}`,
  quantity: 1,
  qty_unit: 'PAQ',
  qty_presentacion: 1,
  unidad_presentacion: 'PAQ',
  delivery_date: null,
  confirmed_at: '2026-10-07',
  ...o,
});

describe('congelarPorPedido', () => {
  it('⭐ el mismo producto en dos renglones del MISMO pedido se suma en una sola fila', () => {
    const out = congelarPorPedido([
      r({ order_id: 'a', product_id: 'p', quantity: 50, qty_unit: 'KG', qty_presentacion: 2, unidad_presentacion: 'BTO' }),
      r({ order_id: 'a', product_id: 'p', quantity: 25, qty_unit: 'KG', qty_presentacion: 1, unidad_presentacion: 'BTO' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].qty_requested).toBe(75);
    expect(out[0].qty_presentacion).toBe(3);
    expect(out[0].unidad_presentacion).toBe('BTO');
  });

  it('el mismo producto en DOS pedidos queda en dos filas (el reparto es por pedido)', () => {
    const out = congelarPorPedido([r({ order_id: 'a', product_id: 'p' }), r({ order_id: 'b', product_id: 'p' })]);
    expect(out.map((x) => x.order_id).sort()).toEqual(['a', 'b']);
  });

  it('la suma de decimales es exacta (61.74 + 0.26 = 62, no 61.99999…)', () => {
    const out = congelarPorPedido([
      r({ order_id: 'a', product_id: 'p', quantity: 61.74 }),
      r({ order_id: 'a', product_id: 'p', quantity: 0.26 }),
    ]);
    expect(out[0].qty_requested).toBe(62);
  });

  it('presentación en dos unidades dentro del mismo pedido: NO se suma, queda null (prueba negativa)', () => {
    const out = congelarPorPedido([
      r({ order_id: 'a', product_id: 'p', qty_presentacion: 1, unidad_presentacion: 'CJA' }),
      r({ order_id: 'a', product_id: 'p', qty_presentacion: 3, unidad_presentacion: 'PAQ' }),
    ]);
    expect(out[0].qty_presentacion).toBeNull();
    expect(out[0].unidad_presentacion).toBeNull();
  });

  it('un renglón sin presentación (pedido de la Suite) deja la presentación en null', () => {
    const out = congelarPorPedido([r({ order_id: 'a', product_id: 'p', qty_presentacion: null, unidad_presentacion: null })]);
    expect(out[0].qty_presentacion).toBeNull();
    expect(out[0].unidad_presentacion).toBeNull();
  });

  it('ignora renglones sin producto y los de cantidad cero (no inventa filas)', () => {
    const out = congelarPorPedido([
      r({ order_id: 'a', product_id: null }),
      r({ order_id: 'b', product_id: 'p', quantity: 0 }),
    ]);
    expect(out).toEqual([]);
  });

  it('conserva lo que ordena el reparto (fecha de entrega y confirmación)', () => {
    const out = congelarPorPedido([r({ order_id: 'a', product_id: 'p', delivery_date: '2026-10-09', confirmed_at: '2026-10-07' })]);
    expect(out[0].delivery_date).toBe('2026-10-09');
    expect(out[0].confirmed_at).toBe('2026-10-07');
  });
});

describe('presentacionDeProducto · lo que cuenta el surtidor', () => {
  it('⭐ suma los bultos de todos los pedidos cuando todos piden en la misma unidad', () => {
    expect(
      presentacionDeProducto([
        { qty_presentacion: 3, unidad_presentacion: 'BTO' },
        { qty_presentacion: 2, unidad_presentacion: 'BTO' },
      ]),
    ).toEqual({ cantidad: 5, unidad: 'BTO' });
  });

  it('unidades distintas entre pedidos → null (prueba negativa: no suma cajas con paquetes)', () => {
    expect(
      presentacionDeProducto([
        { qty_presentacion: 1, unidad_presentacion: 'CJA' },
        { qty_presentacion: 4, unidad_presentacion: 'PAQ' },
      ]),
    ).toBeNull();
  });

  it('si un pedido no trae presentación → null', () => {
    expect(
      presentacionDeProducto([
        { qty_presentacion: 1, unidad_presentacion: 'CJA' },
        { qty_presentacion: null, unidad_presentacion: 'CJA' },
      ]),
    ).toBeNull();
  });

  it('sin pedidos → null', () => {
    expect(presentacionDeProducto([])).toBeNull();
  });
});
