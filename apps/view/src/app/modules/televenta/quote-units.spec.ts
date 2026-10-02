import { describe, it, expect } from 'vitest';
import { abrevUnidadBase, desglose, nombreUnidadBase, opcionesUnidad, paqueteDeCaja } from './quote-units';
import { etiquetaDesglose } from './quote-deliverable-export';
import type { QuoteCatalogRow } from './quotes.service';

/**
 * COT.16 — los botones de unidad y el desglose del precio. Los casos son productos reales de la
 * sucursal 01 (medidos en prod, solo lectura, 2026-10-01).
 */
const fila = (o: Partial<QuoteCatalogRow>): QuoteCatalogRow => ({
  sku: 'X',
  name: null,
  content: null,
  barcode: null,
  unit_base: 'PZA',
  piece_price: 1,
  pack_size: null,
  box_size: null,
  box_label: null,
  sold_by_kg: false,
  ...o,
});

describe('opcionesUnidad — de menor a mayor, sólo las que el ERP declara', () => {
  it('KINDER DELICE (42029): Pieza 1 · Paquete 10 · Caja 140 (antes salía Pieza · Caja · Paquete)', () => {
    const o = opcionesUnidad(fila({ unit_base: 'PZA', pack_size: 10, box_size: 140, box_label: 'CJA' }));
    expect(o.map((x) => `${x.titulo} ${x.tamano}`)).toEqual(['Pieza 1', 'Paquete 10', 'Caja 140']);
  });

  it('un producto con una sola unidad pinta UN solo botón', () => {
    expect(opcionesUnidad(fila({ unit_base: 'PZA' }))).toHaveLength(1);
  });

  it('el gansito (base PAQ) dice "Paquete", no "Pieza"', () => {
    const o = opcionesUnidad(fila({ unit_base: 'PAQ', box_size: 12, box_label: 'CJA' }));
    expect(o.map((x) => x.titulo)).toEqual(['Paquete', 'Caja']);
    expect(o[1].detalle).toBe('12 PAQ');
  });

  it('granel por kilo con bulto: Kilo · Bulto 20 kg', () => {
    const o = opcionesUnidad(fila({ unit_base: 'KG', sold_by_kg: true, box_size: 20, box_label: 'BTO' }));
    expect(o.map((x) => `${x.titulo} ${x.detalle}`)).toEqual(['Kilo 1 kg', 'Bulto 20 kg']);
  });
});

describe('unidad base — nunca un rótulo inventado', () => {
  it('rótulos que el ERP usa como unidad pero no lo son ("500") se muestran como "Unidad"', () => {
    expect(nombreUnidadBase('500')).toBe('Unidad');
    expect(abrevUnidadBase('500')).toBe('u.');
  });
  it('vendido por kilo gana sobre el rótulo', () => {
    expect(abrevUnidadBase('PZA', true)).toBe('KG');
  });
});

describe('etiquetaDesglose — el texto que llega al Excel/PDF del cliente', () => {
  it('un bulto de 20 KG dice "20 KG", no "20PZS"', () => {
    expect(etiquetaDesglose(20, 'KG', 56.5)).toBe('(20 KG 56.50)');
  });
  it('una caja de 12 paquetes dice "12 PAQ"', () => {
    expect(etiquetaDesglose(12, 'PAQ', 41.82)).toBe('(12 PAQ 41.82)');
  });
  it('sin unidad conocida cae a PZA (lo de antes)', () => {
    expect(etiquetaDesglose(12, null, 80.82)).toBe('(12 PZA 80.82)');
  });
});

describe('COT.17 — la unidad del MEDIO (el paquete dentro de la caja)', () => {
  it('KINDER DELICE: caja de 140 a $1,706.06 → 14 PAQ $121.86 · 140 PZA $12.19', () => {
    const d = desglose(1706.06, 140, 'PZA', 10);
    expect(d.map((p) => `${p.cantidad} ${p.unidad} ${p.precio.toFixed(2)}`)).toEqual(['14 PAQ 121.86', '140 PZA 12.19']);
  });
  it('en el Excel/PDF: "(14 PAQ 121.86 · 140 PZA 12.19)"', () => {
    expect(etiquetaDesglose(140, 'PZA', 1706.06 / 140, 10)).toBe('(14 PAQ 121.86 · 140 PZA 12.19)');
  });
  it('sin paquete queda igual que antes (sólo la base)', () => {
    expect(etiquetaDesglose(12, 'PAQ', 41.82, null)).toBe('(12 PAQ 41.82)');
    expect(desglose(501.8, 12, 'PAQ')).toHaveLength(1);
  });
  it('un paquete que NO cabe exacto en la caja no se inventa ("13.3 PAQ")', () => {
    expect(paqueteDeCaja(40, 3)).toBeNull();
    expect(desglose(100, 40, 'PZA', 3)).toHaveLength(1);
  });
  it('paquete igual o mayor que la caja, o de 1, no es unidad del medio', () => {
    expect(paqueteDeCaja(12, 12)).toBeNull();
    expect(paqueteDeCaja(12, 1)).toBeNull();
    expect(paqueteDeCaja(null, 10)).toBeNull();
  });
  it('una unidad base (factor 1) no se desglosa', () => {
    expect(desglose(12.19, 1, 'PZA', 10)).toEqual([]);
  });
});
