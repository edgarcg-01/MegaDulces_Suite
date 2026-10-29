// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { TOLERANCIA_KEPLER_WINCAJA, TOLERANCIA_MAYOR_515, veredictoCuadre } from './veredicto-cuadre';

describe('[MX.1.2] veredictoCuadre — un vacío no cuadra', () => {
  it('⛔ los dos lados vacíos NO son «cuadra»: son «sin datos»', () => {
    // El caso que reportó Edgar: antes `Number(x) || 0` daba delta 0 → «cuadra» en verde.
    expect(veredictoCuadre(0, 0, TOLERANCIA_MAYOR_515)).toBe('sin_datos');
    expect(veredictoCuadre(null, null, TOLERANCIA_MAYOR_515)).toBe('sin_datos');
    expect(veredictoCuadre(undefined, 1000, TOLERANCIA_MAYOR_515)).toBe('sin_datos');
    expect(veredictoCuadre('', '', TOLERANCIA_KEPLER_WINCAJA)).toBe('sin_datos');
    expect(veredictoCuadre('abc', 1000, TOLERANCIA_KEPLER_WINCAJA)).toBe('sin_datos');
  });

  it('dinero de un solo lado sin base es diferencia, no «sin datos»', () => {
    expect(veredictoCuadre(-250, 0, TOLERANCIA_MAYOR_515)).toBe('difiere');
    expect(veredictoCuadre('1200.50', null, TOLERANCIA_KEPLER_WINCAJA)).toBe('difiere');
  });

  it('con base, la tolerancia del lente decide', () => {
    expect(veredictoCuadre(0.5, 10_000, TOLERANCIA_MAYOR_515)).toBe('cuadra');      // < $1
    expect(veredictoCuadre(-9, 10_000, TOLERANCIA_MAYOR_515)).toBe('cuadra');       // < 0.1 %
    expect(veredictoCuadre(11, 10_000, TOLERANCIA_MAYOR_515)).toBe('difiere');
    expect(veredictoCuadre(499, 1_000, TOLERANCIA_KEPLER_WINCAJA)).toBe('cuadra');  // < $500
    expect(veredictoCuadre(-1_900, 100_000, TOLERANCIA_KEPLER_WINCAJA)).toBe('cuadra'); // < 2 %
    expect(veredictoCuadre(2_100, 100_000, TOLERANCIA_KEPLER_WINCAJA)).toBe('difiere');
  });

  it('acepta los numeric de Postgres como texto', () => {
    expect(veredictoCuadre('0.00', '0.00', TOLERANCIA_MAYOR_515)).toBe('sin_datos');
    expect(veredictoCuadre('0.40', '125000.00', TOLERANCIA_MAYOR_515)).toBe('cuadra');
  });
});
