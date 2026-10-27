import { mensajeFraccion, piezasEnteras, renglonesConFraccion, renglonesSinUnidadEntera } from './fraccion-caja';

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

  it('[PQ.17] piezasEnteras: una fracción de caja que es piezas enteras se reconoce (los casos reales de prod)', () => {
    // 0.4 cj × 10 = 4 pz · 0.489 × 45 = 22.005 (tolerancia 0.02) · 0.007 × 144 = 1.008 · 2.083 × 24 = 49.99
    expect(piezasEnteras({ sku: 'a', final_qty: 0.4, piezas_por_caja: 10 })).toBe(4);
    expect(piezasEnteras({ sku: 'b', final_qty: '0.489', piezas_por_caja: '45' })).toBe(22);
    expect(piezasEnteras({ sku: 'c', final_qty: 0.007, piezas_por_caja: 144 })).toBe(1);
    expect(piezasEnteras({ sku: 'd', final_qty: 2.083, piezas_por_caja: 24 })).toBe(50);
  });

  it('[PQ.17] NEGATIVA: sin factor, factor 0, o piezas no enteras → null; y cero piezas no es una cantidad', () => {
    expect(piezasEnteras({ sku: 'a', final_qty: 0.4 })).toBeNull();
    expect(piezasEnteras({ sku: 'a', final_qty: 0.4, piezas_por_caja: 0 })).toBeNull();
    expect(piezasEnteras({ sku: 'a', final_qty: 0.3, piezas_por_caja: 7 })).toBeNull();   // 2.1 pz
    expect(piezasEnteras({ sku: 'a', final_qty: 0.001, piezas_por_caja: 10 })).toBeNull(); // 0.01 pz → 0
  });

  it('[PQ.17] renglonesSinUnidadEntera: deja pasar cajas enteras y piezas enteras; frena lo demás', () => {
    const out = renglonesSinUnidadEntera([
      { sku: 'caja', final_qty: 3, piezas_por_caja: 12 },
      { sku: 'piezas', final_qty: 0.25, piezas_por_caja: 8 },
      { sku: 'ni', final_qty: 0.3, piezas_por_caja: 7 },
      { sku: 'sinfactor', final_qty: 0.5 },
    ]);
    expect(out.map((l) => l.sku)).toEqual(['ni', 'sinfactor']);
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
