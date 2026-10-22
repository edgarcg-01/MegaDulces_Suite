import { escaleraDisjunta, tramoDeCantidad, type VolumeTier } from './quote-pricing.service';

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
