import { codigoDeBarrasDePedido, folioDeLectura } from './pedido-etiqueta';

describe('[MCP.32] codigoDeBarrasDePedido', () => {
  it('12 dígitos: 99 + año + número a 6', () => {
    expect(codigoDeBarrasDePedido('PD-2026-00012')).toBe('992026000012');
    expect(codigoDeBarrasDePedido('pd-2026-123456')).toBe('992026123456');
  });
  it('lo que no es un folio de la Suite: null (la etiqueta sale sólo con QR)', () => {
    expect(codigoDeBarrasDePedido('03UD1001-0018665')).toBeNull();
    expect(codigoDeBarrasDePedido('PD-2026-1234567')).toBeNull();
    expect(codigoDeBarrasDePedido(null)).toBeNull();
  });
});

describe('[MCP.33] folioDeLectura', () => {
  it('lee el QR, el código de barras y el folio tecleado', () => {
    expect(folioDeLectura('PD-2026-00012')).toBe('PD-2026-00012');
    expect(folioDeLectura('992026000012')).toBe('PD-2026-00012');
    expect(folioDeLectura(' pd 2026 12 ')).toBe('PD-2026-00012');
  });
  it("un lector con teclado en español manda ' en lugar de -", () => {
    expect(folioDeLectura("PD'2026'00012")).toBe('PD-2026-00012');
  });
  it('ida y vuelta: lo que se imprime se lee igual', () => {
    for (const f of ['PD-2026-00001', 'PD-2026-99999', 'PD-2027-123456']) {
      expect(folioDeLectura(codigoDeBarrasDePedido(f))).toBe(f);
    }
  });
  it('negativa: un código de producto, una etiqueta del checado o basura no son pedido', () => {
    expect(folioDeLectura('7501000111206')).toBeNull(); // EAN-13
    expect(folioDeLectura('000278110003')).toBeNull(); // etiqueta del checado
    expect(folioDeLectura('992026000000')).toBeNull(); // número 0
    expect(folioDeLectura('gomitas')).toBeNull();
    expect(folioDeLectura('')).toBeNull();
  });
});
