import { referenciaDelAjuste } from './referencia-ajuste';

describe('[RE.74] la referencia del ajuste dice lo que es', () => {
  it('si trae el código del proveedor, lo dice (no es una factura)', () => {
    expect(referenciaDelAjuste('C0153', 'C0153')).toBe('C0153 (es el código del proveedor, no una factura)');
  });

  it('control: una referencia distinta se muestra tal cual', () => {
    expect(referenciaDelAjuste('A-12345', 'C0153')).toBe('A-12345');
  });

  it('vacía es null (no se inventa)', () => {
    expect(referenciaDelAjuste('  ', 'C0153')).toBeNull();
    expect(referenciaDelAjuste(null, 'C0153')).toBeNull();
  });
});
