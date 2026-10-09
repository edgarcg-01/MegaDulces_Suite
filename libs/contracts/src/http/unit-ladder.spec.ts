import { componerEnEscalera, escaleraUnidades, factorDeRotulo } from './unit-ladder.contract';

/**
 * `[NP.16]` La cantidad escrita en la escalera del artículo: cajas enteras y lo demás en paquetes o
 * piezas. Los factores son los de una ficha real (96087 Kinder Delice: paquete de 10, caja de 60;
 * el factor del costo trae decimales, el de la caja no).
 */
const KINDER = escaleraUnidades({ u1: 'PZA', u2: 'PAQ', u3: 'CJA', f2: '9.9961', f3: '59.9786', uxc: 60 });
const CAJA_12 = escaleraUnidades({ u1: 'PZA', u2: 'CJA', u3: null, f2: 12, f3: null, uxc: 12 });

describe('[NP.16] factorDeRotulo', () => {
  it('cada rótulo de Kepler, en unidades base de SU escalera', () => {
    expect(factorDeRotulo('PZA', KINDER)).toBe(1);
    expect(factorDeRotulo('paq', KINDER)).toBe(10);
    expect(factorDeRotulo('CJA', KINDER)).toBe(60);
    // CAJA y CJA son la misma unidad.
    expect(factorDeRotulo('CAJA', CAJA_12)).toBe(12);
  });

  it('⛔ fuera de la escalera, o con dos peldaños del mismo rótulo, no se adivina', () => {
    expect(factorDeRotulo('PAQ', CAJA_12)).toBeNull();
    expect(factorDeRotulo('', KINDER)).toBeNull();
    // 89106: PAQ ×1 y PAQ ×24. Un documento en "PAQ" puede ser cualquiera de los dos.
    const doble = escaleraUnidades({ u1: 'PAQ', u2: 'PAQ', u3: null, f2: 24, uxc: 24 });
    expect(doble.map((e) => e.factor)).toEqual([1, 24]);
    expect(factorDeRotulo('PAQ', doble)).toBeNull();
  });
});

describe('[NP.16] componerEnEscalera', () => {
  const texto = (r: ReturnType<typeof componerEnEscalera>) => r?.partes.map((p) => `${p.cantidad} ${p.rotulo}`).join(' · ');

  it('⭐ cajas enteras y lo que sobra en paquetes y piezas', () => {
    expect(texto(componerEnEscalera({ PZA: 334 }, KINDER))).toBe('5 CJA · 3 PAQ · 4 PZA');
    expect(texto(componerEnEscalera({ PZA: 13 }, CAJA_12))).toBe('1 CJA · 1 PZA');
    expect(texto(componerEnEscalera({ CJA: 60 }, KINDER))).toBe('60 CJA');
  });

  it('⭐ rótulos distintos se juntan en la base antes de partir: 178 paquetes y 2 piezas son 29 cajas, 4 paquetes y 2 piezas', () => {
    expect(texto(componerEnEscalera({ PAQ: 178, PZA: 2 }, KINDER))).toBe('29 CJA · 4 PAQ · 2 PZA');
    expect(texto(componerEnEscalera({ CJA: 5, PAQ: 45, PZA: 40 }, KINDER))).toBe('13 CJA · 1 PAQ');
  });

  it('menos de una caja: sin "0 cajas"', () => {
    expect(texto(componerEnEscalera({ PZA: 34 }, KINDER))).toBe('3 PAQ · 4 PZA');
    expect(texto(componerEnEscalera({ PZA: 8 }, CAJA_12))).toBe('8 PZA');
  });

  it('un bulto de kilos con factor fraccionario: bultos enteros y el resto con decimales', () => {
    const bulto = escaleraUnidades({ u1: 'KG', u2: 'BTO', f2: 6.84, uxc: 6.84 });
    expect(texto(componerEnEscalera({ KG: 20 }, bulto))).toBe('2 BTO · 6.32 KG');
    // El flotante no se come una caja.
    expect(texto(componerEnEscalera({ PZA: 59.9999999999 }, KINDER))).toBe('1 CJA');
  });

  it('⛔ lo que no se puede convertir va aparte, tal cual, y no se suma', () => {
    const r = componerEnEscalera({ PZA: 13, '500': 3 }, CAJA_12);
    expect(texto(r)).toBe('1 CJA · 1 PZA');
    expect(r?.sin_convertir).toEqual({ '500': 3 });
  });

  it('⛔ sin escalera, sin nada que convertir, o con total no positivo: NULL (se muestra como vino)', () => {
    expect(componerEnEscalera({ PZA: 13 }, null)).toBeNull();
    expect(componerEnEscalera({ '?': 3 }, KINDER)).toBeNull();
    expect(componerEnEscalera({}, KINDER)).toBeNull();
    expect(componerEnEscalera({ PZA: -4 }, KINDER)).toBeNull();
  });

  it('una sola unidad: todo en la base', () => {
    const una = escaleraUnidades({ u1: 'KG', u2: 'KG', u3: 'KG', f2: 1, f3: 1, uxc: 1 });
    expect(texto(componerEnEscalera({ KG: 12.5 }, una))).toBe('12.5 KG');
  });
});
