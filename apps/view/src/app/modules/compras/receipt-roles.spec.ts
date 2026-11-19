import { describe, expect, it } from 'vitest';
import { checklist, missingGroups } from './receipt-roles';

describe('[RE.82] la hoja de Kepler declarada «factura» no cumple la factura', () => {
  it('sola, el checklist deja la factura faltante (Guardar no se habilita)', () => {
    const hojas = [{ role: 'factura', ocrDocs: ['aplica_orden_entrada'] }];
    expect(missingGroups(hojas, 'kepler').map((g) => g.label)).toEqual(['Factura']);
    expect(checklist(hojas, 'kepler').find((c) => c.label === 'Orden de entrada')?.ok).toBe(true);
  });

  it('con la factura del proveedor al lado, cumple', () => {
    const hojas = [{ role: 'factura', ocrDocs: ['aplica_orden_entrada', 'factura'] }];
    expect(missingGroups(hojas, 'kepler')).toEqual([]);
  });

  it('la nota de venta del proveedor (ticket/vale) junto a la hoja sigue valiendo', () => {
    expect(missingGroups([{ role: 'factura', ocrDocs: ['aplica_orden_entrada', 'ticket'] }], 'kepler')).toEqual([]);
    expect(missingGroups([{ role: 'factura', ocrDocs: ['vale'] }], 'kepler')).toEqual([]);
  });

  it('sin lectura del OCR manda el rol declarado (no se frena lo no probado)', () => {
    expect(missingGroups([{ role: 'factura', ocrDocs: [] }], 'kepler')).toEqual([]);
    expect(missingGroups([{ role: 'factura' }], 'wincaja')).toEqual([]);
  });

  it('la hoja de Kepler + otra hoja leída como factura, cumple', () => {
    const hojas = [{ role: 'factura', ocrDocs: ['aplica_orden_entrada'] }, { role: 'orden_entrada', ocrDocs: ['factura'] }];
    expect(missingGroups(hojas, 'kepler')).toEqual([]);
  });
});
