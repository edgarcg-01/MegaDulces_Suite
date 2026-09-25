import { roundSeed } from './pedido-redondeo';

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
