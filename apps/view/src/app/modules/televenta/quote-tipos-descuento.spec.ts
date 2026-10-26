import { describe, it, expect } from 'vitest';
import { TIPOS_DE_DESCUENTO, FUENTE_PRECIO, definicionDescuento } from './quote-units';
import { explicacionDelPrecio } from './quote-discount-breakdown';
import { condiciones, modeloEntregable, type QuoteDeliverableData } from './quote-deliverable-export';
import { CONTEXT_HELP } from '../../shared/context-help/context-help.dictionary';

/**
 * `[E.29]` «Explicar qué tipo de descuento es cada uno»: en el renglón (lo concreto), en la ayuda
 * de la pantalla y en el papel (la definición). Las dos últimas salen de la MISMA lista.
 */
describe('tipos de descuento', () => {
  it('en el renglón: lo que el motor escribió de cada paso que no es la lista, con fecha dd/mm/aaaa', () => {
    expect(explicacionDelPrecio([
      { step: 'lista', detail: 'Precio de lista del peldaño pack (PAQ)' },
      { step: 'promo_cantidad', detail: '50% desde 1 PAQ · vigente hasta 2026-11-22' },
    ])).toBe('50% desde 1 PAQ · vigente hasta 22/11/2026');
    expect(explicacionDelPrecio([
      { step: 'lista', detail: 'Precio de lista' },
      { step: 'volumen', detail: 'Precio por volumen de 10 a más PAQ' },
    ])).toBe('Precio por volumen de 10 a más PAQ');
    expect(explicacionDelPrecio([{ step: 'lista', detail: 'Precio de lista' }])).toBe('');
    expect(explicacionDelPrecio(null)).toBe('');
  });

  it('cada tipo tiene su etiqueta (la de «De dónde sale») y una definición en palabra llana', () => {
    for (const t of TIPOS_DE_DESCUENTO) {
      expect(FUENTE_PRECIO[t.clave], t.clave).toBeTruthy();
      expect(t.def.length, t.clave).toBeGreaterThan(40);
    }
    expect(definicionDescuento('Volumen')).toMatch(/MISMA presentación/);
    expect(definicionDescuento('Algo que no es descuento')).toBeNull();
  });

  it('la ayuda de la pantalla dice LO MISMO que el papel (una sola lista)', () => {
    const topic = CONTEXT_HELP['cotizacion-descuentos'];
    expect(topic).toBeDefined();
    const grupo = topic.groups?.find((g) => g.heading.startsWith('Tipos de descuento'));
    expect(grupo?.entries).toEqual(TIPOS_DE_DESCUENTO.map((t) => ({ term: FUENTE_PRECIO[t.clave], def: t.def })));
  });

  it('el papel explica SÓLO los descuentos que aparecen en la cotización', () => {
    const base: QuoteDeliverableData = {
      customerCode: 'C1', customerName: 'Cliente', branchCode: '01', branchName: 'Padre Hidalgo',
      validUntil: '2026-11-07', discountPct: null,
      items: [
        { sku: 'A', name: 'Con volumen', unit_label: 'PAQ', quantity: 7, unit_price: 24.79, list_price: 26.94, line_total: 173.53, price_source: 'Volumen' },
        { sku: 'B', name: 'De lista', unit_label: 'PZA', quantity: 1, unit_price: 10, list_price: 10, line_total: 10, price_source: 'Lista' },
      ],
    };
    const leyenda = (d: QuoteDeliverableData) =>
      condiciones(d, modeloEntregable(d)).filter((c) => TIPOS_DE_DESCUENTO.some((t) => c.startsWith(FUENTE_PRECIO[t.clave] + ':')));
    expect(leyenda(base)).toEqual([`Volumen: ${definicionDescuento('Volumen')}`]);
    // NEGATIVO: sólo lista, sin descuento del cliente → ninguna leyenda.
    expect(leyenda({ ...base, items: [base.items[1]] })).toEqual([]);
    // Con % del cliente se explica también el suyo.
    expect(leyenda({ ...base, discountPct: 3 })).toEqual([
      `Volumen: ${definicionDescuento('Volumen')}`,
      `Descuento del cliente: ${definicionDescuento('Descuento del cliente')}`,
    ]);
  });
});
