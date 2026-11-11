import type { PresaleSellerOrder } from '@megadulces/contracts';
import { articulosDelPedido, cantidadMostrada, enOrdenDeCaptura, filtrarPedidos } from './articulos-pedido';

/** `[MCP.15]` Mis pedidos: qué pidió y qué surtieron, artículo por artículo, sin inventar números. */
const pedido = (o: Partial<PresaleSellerOrder> = {}): PresaleSellerOrder => ({
  order_id: 'o1', code: 'PD-2026-00400', customer_name: 'TIENDA PRUEBA', requested_delivery_date: '2026-11-10', total: 100, lines: 3,
  status: 'confirmed', scheduled_at: null, warehouse_name: 'Sucursal', started: null, finished: null, report: null,
  review: null, reviewed: null, charge: null, delivered_at: null, report_unseen: false, ...o,
} as PresaleSellerOrder);
const persona = { user_id: 's', name: 'Surtidor Prueba', at: '2026-11-10T16:00:00.000Z' };
const LINEAS = [
  { id: 'l1', product_name: 'PALETA PRUEBA', quantity: 48, qty_unit: 'CJA', qty_factor: 24 },
  { id: 'l2', product_name: 'CHICLE PRUEBA', quantity: 60, qty_unit: 'PAQ', qty_factor: 20 },
  { id: 'l3', product_name: 'SUSTITUTO PRUEBA', quantity: 5, qty_unit: null, qty_factor: null },
];
const forma = (xs: ReturnType<typeof articulosDelPedido>) => (xs ?? []).map((a) => [a.producto, a.pidio, a.surtio, a.unidad, a.cambio]);

describe('cantidadMostrada', () => {
  it('en la unidad capturada si da entera; si no, en piezas', () => {
    expect(cantidadMostrada({ quantity: 48, qty_unit: 'CJA', qty_factor: 24 })).toEqual({ qty: 2, unit: 'CJA' });
    expect(cantidadMostrada({ quantity: 50, qty_unit: 'CJA', qty_factor: 24 })).toEqual({ qty: 50, unit: 'PZA' });
    expect(cantidadMostrada({ quantity: '7', qty_unit: null, qty_factor: null })).toEqual({ qty: 7, unit: 'PZA' });
  });
});

describe('articulosDelPedido', () => {
  it('sin surtir: lo que pidió, y «surtió» pendiente (null, no 0)', () => {
    const a = articulosDelPedido(pedido(), LINEAS.slice(0, 2));
    expect(forma(a)).toEqual([['PALETA PRUEBA', 2, null, 'CJA', false], ['CHICLE PRUEBA', 3, null, 'PAQ', false]]);
  });

  it('surtido: lo que no está en el reporte llegó completo; lo ajustado, lo quitado y el sustituto se dicen', () => {
    const p = pedido({
      finished: { ...persona, outcome: 'con_faltantes' },
      report: {
        adjusted: [{ line_id: 'l2', product_name: 'CHICLE PRUEBA', unit: 'PAQ', ordered: 5, picked: 3 }],
        removed: [{ product_name: 'SALSA PRUEBA', unit: 'CJA', ordered: 1, picked: 0 }],
        substituted: [{ line_id: 'l3', for_line_id: 'lx', for_product_name: 'SALSA PRUEBA', for_sku: null, product_id: 'p3', product_name: 'SUSTITUTO PRUEBA', sku: null, quantity: 5, unit: 'PZA', line_total: 10 }],
        total_before: 200, total_after: 150,
      },
    } as Partial<PresaleSellerOrder>);
    const a = articulosDelPedido(p, LINEAS)!;
    expect(forma(a)).toEqual([
      ['PALETA PRUEBA', 2, 2, 'CJA', false],
      ['CHICLE PRUEBA', 5, 3, 'PAQ', true],
      ['SUSTITUTO PRUEBA', null, 5, 'PZA', true],
      ['SALSA PRUEBA', 1, 0, 'CJA', true],
    ]);
    expect(a[2].enLugarDe).toBe('SALSA PRUEBA');
  });

  it('[MCP.17] no hubo la caja completa: el mismo producto en piezas dice qué unidad faltó (y otro producto, sólo el nombre)', () => {
    const p = pedido({
      finished: { ...persona, outcome: 'con_faltantes' },
      report: {
        adjusted: [],
        removed: [{ line_id: 'lx', product_name: 'SALSA PRUEBA', unit: 'CJA', ordered: 1, picked: 0 }],
        substituted: [{ line_id: 'l3', for_line_id: 'lx', for_product_name: 'SALSA PRUEBA', for_sku: null, product_id: 'px', product_name: 'SALSA PRUEBA', sku: null, quantity: 5, unit: 'PZA', line_total: 10, same_product: true }],
        total_before: 200, total_after: 10,
      },
    } as Partial<PresaleSellerOrder>);
    const lineas = [{ id: 'l3', product_name: 'SALSA PRUEBA', quantity: 5, qty_unit: 'PZA', qty_factor: 1 }];
    expect(articulosDelPedido(p, lineas)!.find((x) => x.clave === 'l3')?.enLugarDe).toBe('SALSA PRUEBA en CJA');
    // Prueba negativa: sin `same_product` es un cambio por otro producto y no se le agrega unidad.
    const otro = { ...p, report: { ...p.report!, substituted: [{ ...p.report!.substituted![0], same_product: undefined }] } } as PresaleSellerOrder;
    expect(articulosDelPedido(otro, lineas)!.find((x) => x.clave === 'l3')?.enLugarDe).toBe('SALSA PRUEBA');
  });

  it('revisado en caja: todos los renglones con pidió, surtió y cómo quedó (sin pedir las líneas)', () => {
    const p = pedido({
      finished: { ...persona, outcome: 'con_faltantes' },
      reviewed: persona,
      review: { total_before: 1, total_after: 2, lines: [
        { key: 'l1', product_name: 'PALETA PRUEBA', unit: 'CJA', ordered: 2, picked: 2, final: 2, returned: 0, resolution: 'bien' },
        { key: 'l2', product_name: 'CHICLE PRUEBA', unit: 'PAQ', ordered: 5, picked: 3, final: 5, returned: 0, resolution: 'completo' },
      ] },
    } as Partial<PresaleSellerOrder>);
    const a = articulosDelPedido(p, null)!;
    expect(a.map((x) => [x.producto, x.pidio, x.surtio, x.quedo, x.cambio])).toEqual([
      ['PALETA PRUEBA', 2, 2, null, false],
      ['CHICLE PRUEBA', 5, 3, 5, true],
    ]);
  });

  it('⛔ [negativa] sin las líneas del pedido (no se pudieron leer) NO inventa: devuelve null', () => {
    expect(articulosDelPedido(pedido(), null)).toBeNull();
    expect(articulosDelPedido(pedido({ finished: { ...persona, outcome: 'completo' } } as Partial<PresaleSellerOrder>), null)).toBeNull();
  });

  it('reporte viejo sin line_id: casa por nombre y unidad sólo si es único', () => {
    const p = pedido({
      finished: { ...persona, outcome: 'con_faltantes' },
      report: { adjusted: [{ product_name: 'CHICLE PRUEBA', unit: 'PAQ', ordered: 5, picked: 3 }], removed: [], total_before: 1, total_after: 1 },
    } as Partial<PresaleSellerOrder>);
    expect(forma(articulosDelPedido(p, LINEAS.slice(0, 2)))[1]).toEqual(['CHICLE PRUEBA', 5, 3, 'PAQ', true]);
  });
});

describe('orden y filtro de Mis pedidos', () => {
  it('por día de entrega y, dentro, por folio (el orden en que se capturaron)', () => {
    const xs = enOrdenDeCaptura([
      pedido({ code: 'PD-2026-00407', requested_delivery_date: '2026-11-10' }),
      pedido({ code: 'PD-2026-00376', requested_delivery_date: '2026-11-10' }),
      pedido({ code: 'PD-2026-00300', requested_delivery_date: '2026-11-11' }),
      pedido({ code: 'PD-2026-00392', requested_delivery_date: '2026-11-10' }),
    ]);
    expect(xs.map((p) => p.code.slice(-3))).toEqual(['376', '392', '407', '300']);
  });

  it('por surtir / surtidos; ⛔ un cancelado no cuenta como «por surtir»', () => {
    const xs = [
      pedido({ code: 'A' }),
      pedido({ code: 'B', finished: { ...persona, outcome: 'completo' } } as Partial<PresaleSellerOrder>),
      pedido({ code: 'C', status: 'cancelled' } as Partial<PresaleSellerOrder>),
    ];
    expect(filtrarPedidos(xs, 'por_surtir').map((p) => p.code)).toEqual(['A']);
    expect(filtrarPedidos(xs, 'surtidos').map((p) => p.code)).toEqual(['B']);
    expect(filtrarPedidos(xs, 'todos')).toHaveLength(3);
  });
});
