import { calcularTotal, describirDiferencia } from './cantidad.util';

describe('calcularTotal — cajas × uxc + sueltas', () => {
  it('20 cajas de 24 son 480 piezas', () => {
    expect(calcularTotal(20, 0, 24)).toBe(480);
  });

  it('suma las sueltas', () => {
    expect(calcularTotal(20, 5, 24)).toBe(485);
  });

  it('sin uxc, las cajas no aportan: sólo cuentan las sueltas', () => {
    // Es el 97% de los SKU (verificado en catalog.product_barcodes). Inventar un
    // factor acá metería cantidades falsas al inventario.
    expect(calcularTotal(20, 5, null)).toBe(5);
    expect(calcularTotal(20, 5, 0)).toBe(5);
  });

  it('ignora negativos y basura en vez de arrastrarlos', () => {
    expect(calcularTotal(-3, 10, 24)).toBe(10);
    expect(calcularTotal(NaN, NaN, 24)).toBe(0);
  });

  it('trunca fracciones: no existen media caja ni media pieza', () => {
    expect(calcularTotal(2.9, 1.7, 10)).toBe(21);
  });
});

describe('describirDiferencia — habla en cajas cuando corresponde', () => {
  it('cero es coincidencia', () => {
    expect(describirDiferencia(0, 24)).toBe('coincide con Kepler');
  });

  it('múltiplo exacto del uxc se dice en cajas', () => {
    expect(describirDiferencia(-48, 24)).toBe('faltan 48 — 2 cajas');
    expect(describirDiferencia(24, 24)).toBe('sobran 24 — 1 caja');
  });

  it('si no es múltiplo exacto, se queda en piezas', () => {
    expect(describirDiferencia(-50, 24)).toBe('faltan 50');
  });

  it('sin uxc o con uxc 1, siempre piezas', () => {
    expect(describirDiferencia(-48, null)).toBe('faltan 48');
    expect(describirDiferencia(-48, 1)).toBe('faltan 48');
  });
});
