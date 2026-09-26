import { cajasYPiezas, diasInventario, dineroCorto, pasoCantidad, pasoPorTecla, roundSeed, TeclaPaso, textoCajasPiezas, textoSumaCajasPiezas } from './pedido-redondeo';

describe('[RA-PRO.51] roundSeed — el sugerido llega redondeado', () => {
  describe('los cuatro ejemplos que el PR promete en su tabla', () => {
    it('147.1 cj → 147 cj', () => {
      expect(roundSeed(147.1, 20)).toEqual({ cajas: 147, unit: 'caja' });
    });
    it('1.5 cj → 2 cj (medio se sube)', () => {
      expect(roundSeed(1.5, 20)).toEqual({ cajas: 2, unit: 'caja' });
    });
    it('0.6 cj → 1 cj', () => {
      expect(roundSeed(0.6, 20)).toEqual({ cajas: 1, unit: 'caja' });
    });
    it('0.4 cj con 20 pz/caja → 8 pz (el canónico queda en 0.4 cajas)', () => {
      expect(roundSeed(0.4, 20)).toEqual({ cajas: 0.4, unit: 'pieza' });
    });
  });

  describe('la frontera de media caja', () => {
    it('exactamente 0.5 → 1 caja cerrada, no piezas', () => {
      expect(roundSeed(0.5, 20)).toEqual({ cajas: 1, unit: 'caja' });
    });
    it('justo debajo de 0.5 va a piezas', () => {
      // 0.49 × 20 = 9.8 → 10 pz → 0.5 cajas. Es pieza, no caja.
      expect(roundSeed(0.49, 20)).toEqual({ cajas: 0.5, unit: 'pieza' });
    });
  });

  describe('nunca se borra ni se rompe con lo que el motor manda', () => {
    it('un sugerido diminuto NO se redondea a cero: mínimo 1 pieza', () => {
      // 0.01 × 20 = 0.2 → round = 0 → max(1) = 1 pieza.
      expect(roundSeed(0.01, 20)).toEqual({ cajas: 1 / 20, unit: 'pieza' });
    });
    it('cero o negativo → sin pedido (0 cajas), nunca NaN', () => {
      expect(roundSeed(0, 20)).toEqual({ cajas: 0, unit: 'caja' });
      expect(roundSeed(-3, 20)).toEqual({ cajas: 0, unit: 'caja' });
    });
    it('NaN → sin pedido, no propaga NaN', () => {
      expect(roundSeed(Number.NaN, 20)).toEqual({ cajas: 0, unit: 'caja' });
    });
  });

  describe('⚠️ uxc inválido no debe producir Infinity ni NaN', () => {
    it('uxc = 0 (sin factor de caja) NO divide por cero — cae a factor 1, sin Infinity', () => {
      const r = roundSeed(0.4, 0);
      expect(Number.isFinite(r.cajas)).toBe(true);
      // Con factor 1, 0.4 cj (< media) va a piezas: max(1, round(0.4)) = 1 pz = 1 caja. Lo que
      // importa es que NO sea Infinity (que es lo que hacía el `pz / uxc` sin guardia).
      expect(r).toEqual({ cajas: 1, unit: 'pieza' });
    });
    it('uxc negativo tampoco', () => {
      const r = roundSeed(0.3, -5);
      expect(Number.isFinite(r.cajas)).toBe(true);
    });
    it('uxc = NaN tampoco', () => {
      const r = roundSeed(0.3, Number.NaN);
      expect(Number.isFinite(r.cajas)).toBe(true);
    });
  });

  describe('el canónico siempre es una cantidad de CAJAS finita y no-negativa', () => {
    for (const ped of [0, 0.1, 0.4, 0.5, 0.9, 1, 1.5, 2.4, 147.1]) {
      for (const uxc of [1, 6, 12, 20, 24]) {
        it(`ped=${ped} uxc=${uxc} → cajas finito ≥ 0`, () => {
          const r = roundSeed(ped, uxc);
          expect(Number.isFinite(r.cajas)).toBe(true);
          expect(r.cajas).toBeGreaterThanOrEqual(0);
        });
      }
    }
  });
});

describe('[RA-PRO.52] cajasYPiezas — el acuse dice cajas cerradas + piezas', () => {
  it('6.5 cj con 12 pz/caja → 6 cj 6 pz (el caso de la captura)', () => {
    expect(cajasYPiezas(6.5, 12)).toEqual({ cj: 6, pz: 6 });
  });
  it('suma de sucursales 5 cj + 4/12 + 1 cj + 2/12 → 6 cj 6 pz, sin arrastrar decimales', () => {
    expect(cajasYPiezas(5 + 4 / 12 + 1 + 2 / 12, 12)).toEqual({ cj: 6, pz: 6 });
  });
  it('cajas exactas → 0 piezas', () => {
    expect(cajasYPiezas(147, 20)).toEqual({ cj: 147, pz: 0 });
  });
  it('menos de una caja → 0 cajas y sólo piezas', () => {
    expect(cajasYPiezas(0.4, 20)).toEqual({ cj: 0, pz: 8 });
  });
  it('fracciones que suman una caja entera se juntan (11.999… pz no queda como "0 cj 12 pz")', () => {
    expect(cajasYPiezas(7 / 12 + 5 / 12, 12)).toEqual({ cj: 1, pz: 0 });
  });
  it('cero o valor inválido → 0 cj 0 pz', () => {
    expect(cajasYPiezas(0, 12)).toEqual({ cj: 0, pz: 0 });
    expect(cajasYPiezas(NaN, 12)).toEqual({ cj: 0, pz: 0 });
    expect(cajasYPiezas(-3, 12)).toEqual({ cj: 0, pz: 0 });
  });
  it('uxc inválido → null (no se inventa la conversión)', () => {
    expect(cajasYPiezas(6.5, 0)).toBeNull();
    expect(cajasYPiezas(6.5, -1)).toBeNull();
    expect(cajasYPiezas(6.5, NaN)).toBeNull();
  });
});

describe('[RA-PRO.52] textoCajasPiezas — el texto que imprimen el acuse y el PDF', () => {
  it('mixto, sólo cajas, sólo piezas y cero', () => {
    expect(textoCajasPiezas(6.5, 12)).toBe('6 cj 6 pz');
    expect(textoCajasPiezas(147, 20)).toBe('147 cj');
    expect(textoCajasPiezas(0.4, 20)).toBe('8 pz');
    expect(textoCajasPiezas(0, 20)).toBe('0 cj');
  });
  it('miles con separador', () => {
    expect(textoCajasPiezas(1293, 20)).toBe('1,293 cj');
  });
  it('uxc inválido → cajas con un decimal', () => {
    expect(textoCajasPiezas(6.54, 0)).toBe('6.5 cj');
  });
});

describe('[RA-PRO.55] textoSumaCajasPiezas — total por almacén de varios productos', () => {
  it('suma cajas cerradas por un lado y piezas sueltas por otro', () => {
    expect(textoSumaCajasPiezas([{ cajas: 6 + 10 / 25, uxc: 25 }, { cajas: 5, uxc: 25 }])).toBe('11 cj 10 pz');
  });
  it('piezas de productos con distinto factor NO se convierten a cajas', () => {
    // 10 pz de 25/caja + 18 pz de 20/caja = 28 pz sueltas, aunque 28 > 25 y > 20.
    expect(textoSumaCajasPiezas([{ cajas: 10 / 25, uxc: 25 }, { cajas: 18 / 20, uxc: 20 }])).toBe('28 pz');
  });
  it('sólo cajas, con separador de miles', () => {
    expect(textoSumaCajasPiezas([{ cajas: 655, uxc: 1 }, { cajas: 797, uxc: 1 }])).toBe('1,452 cj');
  });
  it('lista vacía o todo en cero → 0 cj', () => {
    expect(textoSumaCajasPiezas([])).toBe('0 cj');
    expect(textoSumaCajasPiezas([{ cajas: 0, uxc: 20 }])).toBe('0 cj');
  });
  it('factor inválido: sus cajas se suman tal cual', () => {
    expect(textoSumaCajasPiezas([{ cajas: 2.5, uxc: 0 }, { cajas: 3, uxc: 20 }])).toBe('5.5 cj');
  });
});

describe('[RA-PRO.53] diasInventario — existencia (+ pedido) / (venta 30 d / 30.4)', () => {
  it('hoy (sin pedido) y con el pedido', () => {
    expect(diasInventario(4.1, 26.9)).toBeCloseTo(4.63, 2);
    expect(diasInventario(4.1, 26.9, 23)).toBeCloseTo(30.6, 1);
  });
  it('sin venta → null (no se puede calcular, no es "0 días" ni "infinito")', () => {
    expect(diasInventario(10, 0)).toBeNull();
    expect(diasInventario(10, NaN)).toBeNull();
    expect(diasInventario(10, -3)).toBeNull();
  });
  it('unidad no confiable → null aunque haya venta', () => {
    expect(diasInventario(10, 20, 5, true)).toBeNull();
  });
  it('existencia en cero con venta → 0 días (sí es "urge")', () => {
    expect(diasInventario(0, 37.3)).toBe(0);
  });
});

describe('[RA-PRO.57] pasoCantidad — el + / − del pedido', () => {
  it('entero: suma y resta de a uno', () => {
    expect(pasoCantidad(12, 1)).toBe(13);
    expect(pasoCantidad(12, -1)).toBe(11);
  });
  it('con decimales cae al entero siguiente / anterior', () => {
    expect(pasoCantidad(147.4, 1)).toBe(148);
    expect(pasoCantidad(147.4, -1)).toBe(147);
  });
  it('nunca baja de 0', () => {
    expect(pasoCantidad(0, -1)).toBe(0);
    expect(pasoCantidad(0.4, -1)).toBe(0);
  });
  it('absorbe el ruido de flotante de cajas↔piezas', () => {
    expect(pasoCantidad(3.0000000004, 1)).toBe(4);
    expect(pasoCantidad(2.9999999996, -1)).toBe(2);
  });
  it('valor inválido cuenta como 0', () => {
    expect(pasoCantidad(NaN, 1)).toBe(1);
    expect(pasoCantidad(NaN, -1)).toBe(0);
  });
});

describe('[RA-PRO.59] dineroCorto — resumen de la barra en celular', () => {
  it('millones con un decimal, miles redondeados, menores tal cual', () => {
    expect(dineroCorto(4_284_837)).toBe('$4.3 M');
    expect(dineroCorto(519_337)).toBe('$519 mil');
    expect(dineroCorto(850.4)).toBe('$850');
  });
  it('fronteras: lo que redondea a 1,000 mil se escribe 1 M, nunca "1,000 mil"', () => {
    expect(dineroCorto(999_600)).toBe('$1 M');
    expect(dineroCorto(999_499)).toBe('$999 mil');
    expect(dineroCorto(1_000_000)).toBe('$1 M');
  });
  it('cero, inválido y negativo', () => {
    expect(dineroCorto(0)).toBe('$0');
    expect(dineroCorto(NaN)).toBe('$0');
    expect(dineroCorto(-2500)).toBe('−$3 mil');
  });
});

describe('[RA-PRO.57] pasoPorTecla — qué tecla suma o resta en el pedido', () => {
  const T = (key: string, m: Partial<TeclaPaso> = {}): TeclaPaso =>
    ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...m });

  it('→ suma y ← resta, sin modificadores', () => {
    expect(pasoPorTecla(T('ArrowRight'))).toBe(1);
    expect(pasoPorTecla(T('ArrowLeft'))).toBe(-1);
  });
  it('con Shift / Ctrl / Meta / Alt, ← → quedan nativas (no hay paso)', () => {
    expect(pasoPorTecla(T('ArrowLeft', { shiftKey: true }))).toBe(0);
    expect(pasoPorTecla(T('ArrowRight', { ctrlKey: true }))).toBe(0);
    expect(pasoPorTecla(T('ArrowRight', { metaKey: true }))).toBe(0);
    expect(pasoPorTecla(T('ArrowRight', { altKey: true }))).toBe(0);
  });
  it('Alt + ↑ suma y Alt + ↓ resta (el atajo de antes)', () => {
    expect(pasoPorTecla(T('ArrowUp', { altKey: true }))).toBe(1);
    expect(pasoPorTecla(T('ArrowDown', { altKey: true }))).toBe(-1);
    expect(pasoPorTecla(T('ArrowUp', { altKey: true, shiftKey: true }))).toBe(0);
  });
  it('↑ ↓ solas y Enter NO son paso: mueven de renglón (D.5)', () => {
    expect(pasoPorTecla(T('ArrowUp'))).toBe(0);
    expect(pasoPorTecla(T('ArrowDown'))).toBe(0);
    expect(pasoPorTecla(T('Enter'))).toBe(0);
    expect(pasoPorTecla(T('5'))).toBe(0);
  });
});
