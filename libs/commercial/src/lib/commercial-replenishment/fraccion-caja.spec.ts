import { describe, expect, it } from 'vitest';
import { mensajeFraccion, renglonesConFraccion } from './fraccion-caja';

/**
 * `[RA-FIX.3]` El freno que impide escribirle una fracción de caja al ERP.
 *
 * ⭐ Las pruebas que importan son las NEGATIVAS: un freno que nunca se probó en rojo es una
 * intención. Acá se le dan los valores REALES medidos en prod el 2026-10-19 (`0.0070`, `0.013`,
 * `0.417`) y se exige que los detecte.
 */
describe('[RA-FIX.3] fracción de caja', () => {
  it('deja pasar las cajas completas', () => {
    const l = [{ sku: '70001', final_qty: 66 }, { sku: '88045', final_qty: 1 }, { sku: '59098', final_qty: 0 }];
    expect(renglonesConFraccion(l)).toEqual([]);
  });

  it('⛔ detecta la fracción más chica que existe en prod (0.0070 cajas)', () => {
    const l = [{ sku: 'X', final_qty: 0.007 }];
    expect(renglonesConFraccion(l)).toHaveLength(1);
  });

  it('⛔ detecta las tres fracciones reales medidas, y deja la completa', () => {
    const l = [
      { sku: 'A', final_qty: 0.013 },
      { sku: 'B', final_qty: 0.417 },
      { sku: 'C', final_qty: 22 },
      { sku: 'D', final_qty: 0.083 },
    ];
    expect(renglonesConFraccion(l).map((x) => x.sku)).toEqual(['A', 'B', 'D']);
  });

  it('acepta el numeric como TEXTO, que es como llega de node-pg', () => {
    // Sin esto el freno da falso negativo y todo pasa: `Number('0.013')` sí es fracción, pero
    // una comparación hecha sobre el string no lo vería.
    const l = [{ sku: 'A', final_qty: '0.013' }, { sku: 'B', final_qty: '22.000' }];
    expect(renglonesConFraccion(l).map((x) => x.sku)).toEqual(['A']);
  });

  it('no revienta con entrada vacía ni con basura', () => {
    expect(renglonesConFraccion([])).toEqual([]);
    expect(renglonesConFraccion(undefined as never)).toEqual([]);
    // Un valor no numérico NO se declara fracción: no se midió nada, y rechazar por eso daría un
    // motivo falso. Que lo frene quien valide la cantidad, no este freno.
    expect(renglonesConFraccion([{ sku: 'A', final_qty: 'n/a' }])).toEqual([]);
  });

  it('el mensaje dice CUÁNTOS y CUÁLES, y corta la lista larga', () => {
    const muchos = Array.from({ length: 9 }, (_, i) => ({ sku: `S${i}`, final_qty: 0.5 }));
    const m = mensajeFraccion(muchos);
    expect(m).toContain('9 renglón(es)');
    expect(m).toContain('S0=0.5');
    expect(m).toContain('…');
    expect(m).not.toContain('S8=');
  });
});
