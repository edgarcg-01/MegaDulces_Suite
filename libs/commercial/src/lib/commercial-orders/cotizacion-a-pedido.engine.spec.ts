import { motivoParaNoPasar, renglonesParaPedido, type CotizacionParaVenta } from './cotizacion-a-pedido.engine';

const base: CotizacionParaVenta = {
  id: 'q1', code: 'COT-1', status: 'draft', origin: 'route_visit', user_id: 'u1',
  customer_id: 'c1', warehouse_id: 'w1', order_id: null,
};

describe('[MCP.34] motivoParaNoPasar', () => {
  it('borrador o enviada, del vendedor, con cliente y sucursal: se puede', () => {
    expect(motivoParaNoPasar(base, 'u1')).toBeNull();
    expect(motivoParaNoPasar({ ...base, status: 'sent' }, 'u1')).toBeNull();
  });
  it('ya tiene pedido: no es error (el segundo toque devuelve el mismo pedido)', () => {
    expect(motivoParaNoPasar({ ...base, status: 'accepted', order_id: 'o1' }, 'u1')).toBeNull();
  });
  it('negativas: no existe 404, de otro 403, de telemarketing 409, cerrada 409, sin cliente 409', () => {
    expect(motivoParaNoPasar(null, 'u1')?.http).toBe(404);
    expect(motivoParaNoPasar(base, 'otro')?.http).toBe(403);
    expect(motivoParaNoPasar({ ...base, origin: 'telemarketing' }, 'u1')?.message).toMatch(/telemarketing/);
    expect(motivoParaNoPasar({ ...base, status: 'rejected' }, 'u1')?.message).toMatch(/no compró/);
    expect(motivoParaNoPasar({ ...base, status: 'accepted' }, 'u1')?.http).toBe(409);
    expect(motivoParaNoPasar({ ...base, customer_id: null }, 'u1')?.http).toBe(409);
  });
});

describe('[MCP.34] renglonesParaPedido', () => {
  it('los propios en su unidad; sin regalos, sin ceros; lo que no tiene producto se nombra', () => {
    const r = renglonesParaPedido([
      { product_id: 'p1', product_name: 'Gomitas', requested_text: null, quantity: '2', qty_unit: 'CJA', qty_factor: '24', parent_line_number: null },
      { product_id: 'p2', product_name: 'Chicle', requested_text: null, quantity: 5, qty_unit: null, qty_factor: null, parent_line_number: null },
      { product_id: 'p3', product_name: 'Regalo', requested_text: null, quantity: 1, qty_unit: null, qty_factor: null, parent_line_number: 1 },
      { product_id: 'p4', product_name: 'Cero', requested_text: null, quantity: 0, qty_unit: null, qty_factor: null, parent_line_number: null },
      { product_id: null, product_name: null, requested_text: 'paletas de tamarindo', quantity: 3, qty_unit: null, qty_factor: null, parent_line_number: null },
    ]);
    expect(r.renglones).toEqual([
      { product_id: 'p1', quantity: 2, qty_unit: 'CJA', qty_factor: 24 },
      { product_id: 'p2', quantity: 5 },
    ]);
    expect(r.sinProducto).toEqual(['paletas de tamarindo']);
  });
});
