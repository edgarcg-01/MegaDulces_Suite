import type { PresalePickReport } from '@megadulces/contracts';
import { surtidoPorElSurtidor } from './presale-picking.service';

/**
 * `[MCP.10.1]` Después de la revisión en caja el pedido ya no dice lo que surtió el surtidor. Esta regla
 * lo recupera del reporte del surtido para que su bandeja no le atribuya lo que completó la caja.
 * Caso medido: PD-2026-00203 (PH, 2026-11-03), salsa pedida 2, surtida 1, completada a 2 en caja.
 */
const REPORTE: PresalePickReport = {
  adjusted: [{ product_name: 'SALSA CHAMOY 1L CHILERITO', unit: 'CJA', ordered: 2, picked: 1, line_id: 'l1' }],
  removed: [{
    product_name: 'MAZAPAN GIGANTE', unit: 'PAQ', ordered: 3, picked: 0, line_id: 'l-borrado',
    restore: { product_id: 'p-maz', quantity: 60, qty_unit: 'PAQ', qty_factor: 20, qty_factor_source: null, discount_percent: 0, unit_price: 9, tax_rate: 0, source_warehouse_id: null, line_number: 3, notes: null },
  }],
  total_before: 1773.6,
  total_after: 1431.84,
};
const ren = (line_id: string, product_id: string, product_name: string, unit = 'CJA') => ({ line_id, product_id, product_name, unit });

describe('surtidoPorElSurtidor', () => {
  it('recortado al surtir: lo que marcó el surtidor, aunque la caja lo haya completado', () => {
    expect(surtidoPorElSurtidor(ren('l1', 'p-sal', 'SALSA CHAMOY 1L CHILERITO'), REPORTE, 2)).toBe(1);
  });

  it('repuesto por la caja (el surtido lo había borrado): el surtidor surtió 0', () => {
    expect(surtidoPorElSurtidor(ren('l-nuevo', 'p-maz', 'MAZAPAN GIGANTE', 'PAQ'), REPORTE, 3)).toBe(0);
  });

  it('lo que no está en el reporte se surtió completo; sin reporte, también', () => {
    expect(surtidoPorElSurtidor(ren('l9', 'p9', 'BOMBON GRANDE', 'PAQ'), REPORTE, 5)).toBe(5);
    expect(surtidoPorElSurtidor(ren('l1', 'p-sal', 'SALSA CHAMOY 1L CHILERITO'), null, 2)).toBe(2);
  });

  it('reporte viejo sin line_id: empata por nombre y unidad sólo si es único', () => {
    const viejo: PresalePickReport = { ...REPORTE, adjusted: [{ product_name: 'SALSA CHAMOY 1L CHILERITO', unit: 'CJA', ordered: 2, picked: 1 }], removed: [] };
    expect(surtidoPorElSurtidor(ren('lx', 'p-sal', 'SALSA CHAMOY 1L CHILERITO'), viejo, 2)).toBe(1);
    // CONTROL: con dos candidatos no adivina; se queda con lo que dice el pedido.
    const ambiguo: PresalePickReport = { ...viejo, adjusted: [...viejo.adjusted, ...viejo.adjusted] };
    expect(surtidoPorElSurtidor(ren('lx', 'p-sal', 'SALSA CHAMOY 1L CHILERITO'), ambiguo, 2)).toBe(2);
  });
});
