import type { PriceRow } from '../portal/portal.service';
import {
  type CotizacionDetalle,
  type RenglonCotizado,
  fechaCorta,
  linkWhatsApp,
  mensajeWhatsApp,
  numeroWhatsApp,
  paraPedido,
  renglonDe,
  rungDeUnidad,
} from './cotizacion';

/**
 * `[MCP.12]` La cotización del vendedor sin Angular: el peldaño que se cotiza, lo que le llega al
 * cliente y lo que pasa a un pedido. El precio nunca lo pone la app.
 */
const ren = (p: Partial<RenglonCotizado>): RenglonCotizado => ({
  id: 'r', line_number: 1, product_id: 'p1', product_name: 'PALETA PAYASO GRANDE', product_sku: '30117', requested_text: null,
  quantity: 2, qty_unit: 'CJA', qty_factor: 24, unit_price: 228, line_total: 456, parent_line_number: null, ...p,
});
const COT: CotizacionDetalle = {
  id: 'q1', code: 'COT-2026-00147', status: 'draft', valid_until: '2026-11-10', total: 810.5, recipient_name: 'ABARROTES CARMELITA',
  lines: [
    ren({}),
    ren({ id: 'r2', line_number: 2, product_id: 'p2', product_name: 'MAZAPAN GIGANTE 50 G', product_sku: '13205', quantity: 3, qty_unit: 'PAQ', qty_factor: 20, unit_price: 118, line_total: 354 }),
    ren({ id: 'r3', line_number: 3, product_id: 'p3', product_name: 'WAFER GRATIS', product_sku: '00196', quantity: 1, qty_unit: 'PZA', qty_factor: 1, unit_price: 0, line_total: 0, parent_line_number: 2 }),
  ],
};

describe('rungDeUnidad', () => {
  const p = { rungs: [{ rung: 'base', unit: 'PZA', factor: 1, price: 9.8 }, { rung: 'box', unit: 'CJA', factor: 24, price: 228 }] } as unknown as PriceRow;
  it('la unidad elegida da su peldaño; sin escalera o unidad desconocida, la base', () => {
    expect(rungDeUnidad(p, 'CJA')).toBe('box');
    expect(rungDeUnidad(p, 'PZA')).toBe('base');
    expect(rungDeUnidad(p, 'BOL')).toBe('base');
    expect(rungDeUnidad({ rungs: undefined } as unknown as PriceRow, 'CJA')).toBe('base');
  });
});

describe('renglones y regalos', () => {
  it('el renglón del producto es el propio, no el regalo hijo', () => {
    expect(renglonDe(COT.lines, 'p2')?.id).toBe('r2');
    expect(renglonDe(COT.lines, 'p3')).toBeUndefined();
  });
});

describe('lo que le llega al cliente', () => {
  it('folio, productos con cantidad, unidad, SKU e importe, los regalos marcados, total y vigencia', () => {
    const m = mensajeWhatsApp(COT, 'ABARROTES CARMELITA', 'Padre Hidalgo');
    expect(m).toContain('Cotización COT-2026-00147');
    expect(m).toContain('Para: ABARROTES CARMELITA');
    expect(m).toContain('• 2 CJA PALETA PAYASO GRANDE (SKU 30117) · $456.00');
    expect(m).toContain('• 1 PZA WAFER GRATIS (SKU 00196) (regalo)');
    expect(m).toContain('Total: $810.50');
    expect(m).toContain('válidos hasta el 10 nov 2026');
  });
  it('el número: 10 dígitos de México llevan 52; sin número, el vendedor elige el chat', () => {
    expect(numeroWhatsApp(null, '443 123 4567')).toBe('524431234567');
    expect(numeroWhatsApp('+52 1 443 123 4567')).toBe('5214431234567');
    expect(numeroWhatsApp('', 'sin número')).toBeNull();
    expect(linkWhatsApp('hola', null)).toBe('https://wa.me/?text=hola');
  });
  it('la fecha no se corre por la zona horaria del teléfono', () => {
    expect(fechaCorta('2026-11-10')).toBe('10 nov 2026');
    expect(fechaCorta(null)).toBe('');
  });
});

describe('convertir en pedido', () => {
  it('pasan los renglones propios en la unidad cotizada; el regalo no (el pedido lo recalcula)', () => {
    const r = paraPedido(COT.lines);
    expect(r.renglones).toEqual([
      { product_id: 'p1', quantity: 2, sello: { qty_unit: 'CJA', qty_factor: 24 } },
      { product_id: 'p2', quantity: 3, sello: { qty_unit: 'PAQ', qty_factor: 20 } },
    ]);
    expect(r.sinProducto).toEqual([]);
  });
  it('NEGATIVO: un renglón sin producto del catálogo no se pide y se dice', () => {
    const r = paraPedido([ren({ product_id: null, requested_text: 'GOMITAS DE LA COMPETENCIA' }), ren({ id: 'x', quantity: 0 })]);
    expect(r.renglones).toEqual([]);
    expect(r.sinProducto).toEqual(['GOMITAS DE LA COMPETENCIA']);
  });
});
