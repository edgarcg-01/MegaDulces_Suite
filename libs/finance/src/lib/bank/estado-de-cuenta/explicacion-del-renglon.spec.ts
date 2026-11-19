import { explicarRenglon, pesosExplicados } from './explicacion-del-renglon';

/** `[BFU.2.8]` Por qué existe cada peso, y lo que todavía no se sabe. Importes inventados. */
describe('[BFU.2.8] explicarRenglon', () => {
  it('con documento de Kepler: explicado por documento, con su sucursal', () => {
    const e = explicarRenglon({ entra: 1500, sale: 0, documento: { tipo: 'U-A-5', folio: '0000015', sucursal: 'PH' }, categoria: { codigo: 'cobranza', por: 'documento' } });
    expect(e.nivel).toBe('documento');
    expect(e.por[0]).toBe('Kepler U-A-5 0000015 · sucursal PH');
    expect(e.falta).toEqual([]);
  });

  it('una comisión que el banco nombra: explicada por evidencia, sin pedir cliente ni sucursal', () => {
    const e = explicarRenglon({ entra: 0, sale: 12.5, categoria: { codigo: 'comision_bancaria', nombre: 'Comisión bancaria', por: 'banco' } });
    expect(e.nivel).toBe('evidencia');
    expect(e.por).toEqual(['Comisión bancaria (por el texto del banco)']);
    expect(e.falta).toEqual(['documento']);
  });

  it('⛔ D8: un depósito «cobranza» sin otra señal NO está explicado, y dice que falta el cliente', () => {
    const e = explicarRenglon({ entra: 900, sale: 0, categoria: { codigo: 'cobranza', por: 'deposito' } });
    expect(e.explicado).toBe(false);
    expect(e.falta).toEqual(['documento', 'cliente', 'sucursal']);
  });

  it('⛔ D8: tampoco si la cobranza la puso Tesorería con su clave — dice «es un cobro», no de quién', () => {
    expect(explicarRenglon({ entra: 900, sale: 0, categoria: { codigo: 'cobranza', por: 'libro' }, sucursal: '30' }).explicado).toBe(false);
  });

  it('la cobranza con el cliente declarado sí está explicada', () => {
    const e = explicarRenglon({ entra: 900, sale: 0, categoria: { codigo: 'cobranza', por: 'deposito' }, cliente: 'C-0042', sucursal: '30' });
    expect(e.nivel).toBe('evidencia');
    expect(e.falta).toEqual(['documento']);
  });

  it('control: un retiro sin categoría ni documento es «sin explicar» y lo dice todo', () => {
    const e = explicarRenglon({ entra: 0, sale: 4000, categoria: { codigo: 'sin_clasificar', por: 'ninguna' }, contraparte: { referencia: '123' } });
    expect(e.explicado).toBe(false);
    expect(e.falta).toEqual(['documento', 'categoría']);
    expect(e.por).toEqual([]);
  });

  it('la contraparte que da el banco se dice, pero sola no explica', () => {
    const e = explicarRenglon({ entra: 0, sale: 4000, contraparte: { nombre: 'DISTRIBUIDORA X', rfc: 'DXX010101AAA' } });
    expect(e.por).toEqual(['contraparte DISTRIBUIDORA X · DXX010101AAA']);
    expect(e.explicado).toBe(false);
  });
});

describe('[BFU.2.8] pesosExplicados', () => {
  it('en pesos, no en renglones: un retiro grande sin explicar pesa lo que pesa', () => {
    const r = pesosExplicados([
      { entra: 0, sale: 900, explicacion: explicarRenglon({ entra: 0, sale: 900, documento: { tipo: 'X-D-26', folio: '1' } }) },
      { entra: 0, sale: 100, explicacion: explicarRenglon({ entra: 0, sale: 100 }) },
    ]);
    expect(r.pct_explicado).toBe(90);
    expect(r.pct_documento).toBe(90);
    expect(r.pct_sin_explicar).toBe(10);
    expect(r.renglones_sin_explicar).toBe(1);
  });

  it('sin renglones no hay porcentaje: null, nunca 0 ni 100', () => {
    expect(pesosExplicados([]).pct_explicado).toBeNull();
  });
});
