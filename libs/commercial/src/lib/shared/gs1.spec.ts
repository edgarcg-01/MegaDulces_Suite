// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { digitoGs1, esFormaGs1, gs1Valido } from './gs1';

/**
 * `[NP.7.1.3]` Controles con códigos REALES: el EAN del 95805 que leyó la foto (el plan lo fija como
 * control: `7500443006889` → 9) y los de las fichas de Kepler abiertas el 2026-11-02.
 */
describe('gs1 · dígito verificador', () => {
  it('⭐ control del plan: 7500443006889 termina en 9', () => {
    expect(digitoGs1('750044300688')).toBe(9);
    expect(gs1Valido('7500443006889')).toBe(true);
  });

  it('códigos reales de Kepler: EAN-13 y UPC-A', () => {
    expect(gs1Valido('7622210571403')).toBe(true); // Trident pieza (c7)
    expect(gs1Valido('7501056960216')).toBe(true); // Trident paquete (c82)
    expect(gs1Valido('840004096513')).toBe(true); // Tic Tac paquete (c82, UPC-A)
  });

  it('prueba negativa: cambiar un dígito lo invalida', () => {
    expect(gs1Valido('7500443006888')).toBe(false);
    expect(gs1Valido('7500443006898')).toBe(false);
  });

  it('lo que no tiene forma GS1 no es GS1 (clave del SKU, C+clave, CB…)', () => {
    for (const c of ['06001', '000052', 'C06001', 'CB2300052', '', '75004430068']) {
      expect(esFormaGs1(c)).toBe(false);
      expect(gs1Valido(c)).toBe(false);
    }
  });
});
