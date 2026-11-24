import type { PriceRow } from '../portal/portal.service';
import {
  type CotizacionDetalle,
  type RenglonCotizado,
  fechaCorta,
  linkWhatsApp,
  mensajeWhatsApp,
  numeroWhatsApp,
  existenciaParaCotizar,
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

describe('[MCP.35] existenciaParaCotizar', () => {
  const ahora = Date.parse('2026-11-24T12:00:00-06:00');
  const fresco = '2026-11-24T11:00:00-06:00';
  const caja = { rungs: [{ rung: 'base', unit: 'PZA', factor: 1, price: 9 }, { rung: 'box', unit: 'CJA', factor: 24, price: 200 }] } as Pick<PriceRow, 'rungs'>;
  it('en la unidad que se cotiza: 50 piezas son «2 CJA»; si no completa una, en piezas y en ámbar', () => {
    expect(existenciaParaCotizar({ ...caja, stock_state: 'con_existencia', stock_available: 50, stock_checked_at: fresco }, 'CJA', ahora)).toEqual({ texto: 'Existencias: 2 CJA', tono: 'ok' });
    expect(existenciaParaCotizar({ ...caja, stock_state: 'con_existencia', stock_available: 5, stock_checked_at: fresco }, 'CJA', ahora)).toEqual({ texto: 'Existencias: 5 pzas', tono: 'warn' });
    expect(existenciaParaCotizar({ ...caja, stock_state: 'con_existencia', stock_available: 5, stock_checked_at: fresco }, 'PZA', ahora).texto).toBe('Existencias: 5 pzas');
  });
  it('agotado en rojo; no se maneja y sin dato en gris', () => {
    expect(existenciaParaCotizar({ stock_state: 'agotado', stock_available: 0, stock_checked_at: fresco }, 'PZA', ahora)).toEqual({ texto: 'Sin existencias', tono: 'bad' });
    expect(existenciaParaCotizar({ stock_state: 'no_se_maneja', stock_available: null }, 'PZA', ahora).tono).toBe('nd');
    expect(existenciaParaCotizar({ stock_state: 'sin_dato', stock_available: null }, 'PZA', ahora).texto).toBe('Sin dato de existencia');
  });
  it('NEGATIVO: sin lectura no es «0» — y una lectura de más de 6 h es «Sin dato», no un número viejo', () => {
    expect(existenciaParaCotizar({ stock_available: null }, 'PZA', ahora)).toEqual({ texto: 'Sin dato de existencia', tono: 'nd' });
    expect(existenciaParaCotizar({ stock_state: 'con_existencia', stock_available: 80, stock_checked_at: '2026-11-24T05:00:00-06:00' }, 'PZA', ahora).texto).toBe('Sin dato de existencia');
  });
});
