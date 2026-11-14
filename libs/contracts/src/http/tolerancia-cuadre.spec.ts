import { cuadraDentroDeTolerancia, evidenciaCuadra, sqlEvidenciaCuadra, TOLERANCIA_TEXTO } from './tolerancia-cuadre';

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

describe('[RE.79] la evidencia cuadra derivada de lo guardado', () => {
  const ev = (monto_match: boolean | null, ocr_monto: number | null, receipt_monto = 5375, ocr_subtotal: number | null = null) =>
    ({ monto_match, ocr_monto, ocr_subtotal, receipt_monto });

  it('guardado falso con ±$1, pero $1.25 sobre $5,375 cabe en la tolerancia: cuadra', () => {
    expect(evidenciaCuadra(ev(false, 5373.75))).toBe(true);
  });
  it('NEGATIVA: $75 sobre $5,375 (1.4 %) no cuadra', () => {
    expect(evidenciaCuadra(ev(false, 5300))).toBe(false);
  });
  it('el subtotal también cuenta (factura con IVA aparte)', () => {
    expect(evidenciaCuadra(ev(false, 6235, 5375, 5374))).toBe(true);
  });
  it('un true guardado no se revoca; sin lectura sigue null', () => {
    expect(evidenciaCuadra(ev(true, 1))).toBe(true);
    expect(evidenciaCuadra(ev(null, null))).toBeNull();
  });
  it('el SQL usa las mismas constantes y el prefijo', () => {
    const s = sqlEvidenciaCuadra('p.');
    expect(s).toContain('p.monto_match IS NULL');
    expect(s).toContain('< 200');
    expect(s).toContain('< 0.0025 * abs(p.receipt_monto)');
  });
});
