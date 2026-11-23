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

/**
 * `[PQ.147]` **La caja grande no puede ser motivo de rechazo.**
 *
 * El primer pedido que Autoabasto mandó a Kepler (`RQ-2026-03239`, Morelia Madero → Morelia
 * Abastos, 2026-11-23) se frenó con **11 de 294 renglones**, y ninguno estaba mal: eran piezas
 * enteras de cajas grandes. `final_qty` guarda 3 decimales, así que 32 piezas de una caja de 96
 * se guardan como `0.333`; al multiplicar de vuelta dan 31.968 y erraban por 0.032 — más que la
 * tolerancia fija de 0.02 que había en piezas.
 *
 * ⭐ El arreglo no es aflojar el número: es **comparar en la escala donde ocurre el recorte**
 * (cajas), donde el error máximo es media milésima pase lo que pase.
 */
describe('[PQ.147] piezas enteras de cajas grandes', () => {
  /** Los cuatro renglones REALES que rechazó `RQ-2026-03239`, con su factor medido en prod. */
  const reales: ReadonlyArray<[string, number, number, number]> = [
    ['02031', 0.333, 96, 32],   // 32/96 = 0.33333… → 0.333 → ×96 = 31.968
    ['02137', 0.167, 96, 16],   // 16/96 = 0.16666… → 0.167 → ×96 = 16.032
    ['27167', 0.167, 96, 16],
    ['38020', 0.167, 60, 10],   // 10/60 = 0.16666… → 0.167 → ×60 = 10.020
    ['17140', 0.119, 67, 8],    //  8/67 = 0.11940… → 0.119 → ×67 =  7.973
  ];

  it.each(reales)('%s: %s cajas de %i por caja son %i piezas enteras', (sku, final_qty, piezas_por_caja, esperado) => {
    expect(piezasEnteras({ sku, final_qty, piezas_por_caja })).toBe(esperado);
  });

  it('⛔ y por lo tanto NINGUNO de esos renglones frena el envío a Kepler', () => {
    const lineas = reales.map(([sku, final_qty, piezas_por_caja]) => ({ sku, final_qty, piezas_por_caja }));
    expect(renglonesSinUnidadEntera(lineas)).toEqual([]);
  });

  /**
   * ⛔ CONTROL de que el arreglo era necesario: con la tolerancia VIEJA —fija, en piezas— estos
   * mismos renglones se rechazaban. Si alguien vuelve a ese criterio, el de arriba se pone rojo.
   */
  it('CONTROL: la tolerancia vieja (0.02 en piezas) sí los rechazaba — por eso se cambió', () => {
    const viejo = (cajas: number, uxc: number) => {
      const pz = cajas * uxc;
      return Math.abs(pz - Math.round(pz)) <= 0.02;
    };
    expect(reales.filter(([, q, f]) => !viejo(q, f)).map(([sku]) => sku))
      .toEqual(['02031', '02137', '27167', '38020', '17140']);
    // Los CINCO. El de la caja de 60 erraba 0.020 exactos y caía del lado malo por coma flotante
    // (10.020000000000001 - 10); el de 67, 0.027. Ninguno tenía mal la cantidad.
  });

  /**
   * ⛔ NEGATIVA — el freno NO se aflojó. Una cantidad que de verdad no es un número entero de
   * piezas sigue rechazándose, venga de la caja que venga.
   */
  it.each([
    ['media pieza de una caja de 7', 0.4, 7],
    ['pieza y media de una caja de 6', 0.25, 6],
    ['un cuarto de pieza', 0.55, 5],
  ])('⛔ %s NO pasa como pieza entera', (_q, final_qty, piezas_por_caja) => {
    expect(piezasEnteras({ sku: 'x', final_qty, piezas_por_caja })).toBeNull();
    expect(renglonesSinUnidadEntera([{ sku: 'x', final_qty, piezas_por_caja }])).toHaveLength(1);
  });

  it('⛔ y sin factor sigue sin haber con qué juzgarlo: sólo valen cajas enteras', () => {
    expect(piezasEnteras({ sku: 'x', final_qty: 0.333, piezas_por_caja: null })).toBeNull();
    expect(piezasEnteras({ sku: 'x', final_qty: 0.333, piezas_por_caja: 0 })).toBeNull();
  });

  /**
   * ⚠️ El límite declarado: con cajas de más de ~2,000 piezas, tres decimales ya no distinguen
   * una pieza de la siguiente y el criterio toma la más cercana. No ocurre hoy —la caja más
   * grande medida en Morelia Abastos es de 96—, pero queda dicho en vez de descubierto.
   */
  it('una caja enorme se resuelve a la pieza más cercana, y eso se DECLARA', () => {
    expect(piezasEnteras({ sku: 'x', final_qty: 0.0015, piezas_por_caja: 1000 })).toBe(2);
  });
});
