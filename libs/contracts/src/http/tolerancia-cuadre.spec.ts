import { cuadraDentroDeTolerancia, TOLERANCIA_TEXTO } from './tolerancia-cuadre';

describe('[RE.73] tolerancia del cuadre: menos de 0.25 % Y menos de $200', () => {
  it('$1.25 sobre $5,375 cuadra (0.02 %)', () => {
    expect(cuadraDentroDeTolerancia(1.25, 5375)).toBe(true);
  });

  it('NEGATIVA por porcentaje: $1 sobre $300 no cuadra (0.33 %)', () => {
    expect(cuadraDentroDeTolerancia(1, 300)).toBe(false);
  });

  it('NEGATIVA por monto: $250 sobre $1,000,000 no cuadra aunque sea 0.025 %', () => {
    expect(cuadraDentroDeTolerancia(250, 1_000_000)).toBe(false);
  });

  it('el signo no importa', () => {
    expect(cuadraDentroDeTolerancia(-1.25, 5375)).toBe(true);
  });

  it('el texto dice la regla', () => {
    expect(TOLERANCIA_TEXTO).toBe('menos de 0.25 % y de $200');
  });
});
