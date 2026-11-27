import { DIAS_PARA_CONFIRMAR, decidirSinSalidaEnElBanco } from './pago-por-comprobante';

/**
 * `[PGP.232]` El banco re-afirma lo que escribió el comprobante. Después de `confirmarPorElBanco`, un pago que sigue sin
 * salida ligada es un posible rebote SÓLO si la descarga de su cuenta ya cubre la ventana del cruce.
 */
describe('[PGP.232] la salida que el comprobante prometió y el banco no trae', () => {
  it('la ventana es la del cruce del banco: 3 días después del comprobante', () => {
    expect(DIAS_PARA_CONFIRMAR).toBe(3);
  });
  it('⭐ la descarga ya cubre 3 días después del comprobante y la salida no está: sin salida', () => {
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-24', cobertura: '2026-11-27' })).toBe('sin_salida');
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-24', cobertura: '2026-12-02' })).toBe('sin_salida');
  });
  it('CONTROL: la descarga todavía no cubre la ventana: espera, no avisa', () => {
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-24', cobertura: '2026-11-26' })).toBe('espera');
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-24', cobertura: '2026-11-24' })).toBe('espera');
  });
  it('cruza el fin de mes', () => {
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-29', cobertura: '2026-12-02' })).toBe('sin_salida');
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-29', cobertura: '2026-12-01' })).toBe('espera');
  });
  it('⛔ sin descarga de esa cuenta NO se afirma que no salió (ADR-056): no medido', () => {
    expect(decidirSinSalidaEnElBanco({ dia: '2026-11-24', cobertura: null })).toBe('no_medido');
  });
  it('⛔ sin fecha del comprobante, o con una ilegible: no medido', () => {
    expect(decidirSinSalidaEnElBanco({ dia: null, cobertura: '2026-12-31' })).toBe('no_medido');
    expect(decidirSinSalidaEnElBanco({ dia: '24/11/2026', cobertura: '2026-12-31' })).toBe('no_medido');
  });
});
