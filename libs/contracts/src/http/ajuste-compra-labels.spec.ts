import { categoriaAjusteLabel, doctypeAjusteLabel } from './ajuste-compra-labels';

describe('[RE.75] el ajuste se nombra en llano', () => {
  it('categoría conocida', () => {
    expect(categoriaAjusteLabel('descuento_comercial')).toBe('Descuento comercial');
  });
  it('llave desconocida: tal cual, sin inventar', () => {
    expect(categoriaAjusteLabel('rappel_nuevo')).toBe('rappel_nuevo');
  });
  it('sin categoría: null', () => {
    expect(categoriaAjusteLabel(null)).toBeNull();
  });
  it('tipo de documento', () => {
    expect(doctypeAjusteLabel('XD40')).toBe('Devolución');
    expect(doctypeAjusteLabel('XD55')).toBe('Nota de crédito');
  });
});
