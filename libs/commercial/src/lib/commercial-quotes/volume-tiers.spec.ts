import {
  escaleraDisjunta, tramoDeCantidad, unidadMayorQueCabe,
  type LadderRung, type Rung, type VolumeTier,
} from './quote-pricing.service';

/**
 * `[E.22]` El tramo de volumen que Kepler cobra. Caso real (2026-10-21): SKU 89008 en la 01/08,
 * 36 PAQ cobrados a $51.76 en Kepler y cotizados a $55.00 en la Suite (el motor sólo conocía el
 * primer tramo). Escalera de `kdpv_prod_util`, tal cual está en prod.
 */
const PAQ_89008: VolumeTier[] = [
  { desde: 10, hasta: 999999, price: 51.76 },
  { desde: 3, hasta: 5, price: 55.0 },
  { desde: 6, hasta: 9, price: 53.16 },
];

describe('escalera de volumen del ERP', () => {
  it('89008: cada cantidad cobra el tramo que la contiene (lo que Kepler cobró, 120 d)', () => {
    const t = escaleraDisjunta(PAQ_89008)!;
    expect(tramoDeCantidad(t, 2)).toBeNull(); // abajo del primer tramo: lista $55.93
    expect(tramoDeCantidad(t, 4)?.price).toBe(55.0);
    expect(tramoDeCantidad(t, 7)?.price).toBe(53.16);
    expect(tramoDeCantidad(t, 36)?.price).toBe(51.76);
    expect(tramoDeCantidad(t, 38)?.price).toBe(51.76); // la COT-2026-00026 cotizó $55.00
  });

  it('tramos encimados no son escalera: son niveles por transacción y no se derivan (§2.7)', () => {
    expect(escaleraDisjunta([
      { desde: 10, hasta: 999999, price: 71.15 },
      { desde: 10, hasta: 999999, price: 70.51 },
    ])).toBeNull();
    expect(escaleraDisjunta([{ desde: 3, hasta: 10, price: 5 }, { desde: 10, hasta: 20, price: 4 }])).toBeNull();
  });

  it('una cantidad en un hueco entre tramos no toma ninguno (no se adivina)', () => {
    const t = escaleraDisjunta([{ desde: 3, hasta: 5, price: 9 }, { desde: 10, hasta: 99, price: 8 }])!;
    expect(tramoDeCantidad(t, 7)).toBeNull();
  });
});

/**
 * `[E.23]` Caso real: `02195` en la 01, kdii PZA $22.20 · PAQ de 12 $199.72 · CJA de 144 $2,197.95.
 * Pedido de telemarketing 0003315: 144 PZA cobradas a $15.26 (`c66` = 15.2635416667 = CJA / 144).
 */
const LED_02195: { rungs: Record<Rung, LadderRung> } = {
  rungs: {
    base: { rung: 'base', label: 'PZA', price: 22.2, size: 1, volume: null },
    pack: { rung: 'pack', label: 'PAQ', price: 199.72, size: 12, volume: null },
    box: { rung: 'box', label: 'CJA', price: 2197.95, size: 144, volume: null },
  },
};

describe('unidad mayor que cabe en la cantidad (kdm2.c66)', () => {
  const precio = (rung: Rung, qty: number) => {
    const m = unidadMayorQueCabe(LED_02195, rung, qty);
    return m ? Math.round(m.step.price * m.factor * 100) / 100 : null;
  };

  it('144 PZA completan una CJA: la pieza sale a $15.26, como la cobró Kepler', () => {
    expect(unidadMayorQueCabe(LED_02195, 'base', 144)).toMatchObject({ n: 1, step: { label: 'CJA' } });
    expect(precio('base', 144)).toBe(15.26);
  });

  it('143 PZA no llegan a la CJA pero sí a 11 PAQ: la pieza sale al precio del PAQ', () => {
    expect(unidadMayorQueCabe(LED_02195, 'base', 143)).toMatchObject({ n: 11, step: { label: 'PAQ' } });
    expect(precio('base', 143)).toBe(16.64);
  });

  it('12 PAQ son 144 piezas: el PAQ sale a la CJA prorrateada', () => {
    expect(precio('pack', 12)).toBe(183.16);
  });

  it('abajo de la unidad mayor más chica no hay prorrateo: rige la lista propia', () => {
    expect(unidadMayorQueCabe(LED_02195, 'base', 11)).toBeNull();
    expect(unidadMayorQueCabe(LED_02195, 'box', 3)).toBeNull();
  });

  it('un peldaño sin factor no se prorratea (no se adivina el tamaño)', () => {
    const sinFactor = { rungs: { ...LED_02195.rungs, pack: { ...LED_02195.rungs.pack, size: null } } };
    expect(unidadMayorQueCabe(sinFactor, 'pack', 50)).toBeNull();
  });
});
