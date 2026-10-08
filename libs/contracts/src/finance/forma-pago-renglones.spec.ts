import {
  MAX_DETALLES_PAGO, detalleInvalido, detallesDePago, detallesParaMostrar, unirDetallesDePago,
} from './forma-pago.contract';
import { faltaParaMandar, type EstadoAporte } from './aporte-solicitante.contract';

/**
 * `[GX.74]` **Varios renglones en el detalle del pago** (dos tarjetas, dos transferencias…).
 *
 * Se guardan en la misma columna de texto, un renglón por línea. Lo que se vigila: que separar y
 * unir sean simétricos (lo que se escribe es lo que vuelve), que el texto VIEJO de un solo valor
 * se lea como un renglón, y —lo importante— que la regla de `[GX.53]` se aplique a CADA renglón:
 * si sólo mirara el primero, una tarjeta completa entraría en el segundo.
 */
describe('[GX.74] separar y unir los renglones', () => {
  it('un valor viejo (sin saltos) es UN renglón', () => {
    expect(detallesDePago('882301')).toEqual(['882301']);
  });

  it('separa por línea, recorta y descarta los vacíos', () => {
    expect(detallesDePago(' 1234 \n\n 5678\r\n  ')).toEqual(['1234', '5678']);
  });

  it('nulo o vacío → sin renglones', () => {
    expect(detallesDePago(null)).toEqual([]);
    expect(detallesDePago(undefined)).toEqual([]);
    expect(detallesDePago('   ')).toEqual([]);
  });

  it('unir es el inverso de separar (lo escrito es lo que vuelve)', () => {
    const lista = ['882301', 'TRSP-8823'];
    expect(detallesDePago(unirDetallesDePago(lista))).toEqual(lista);
  });

  it('unir descarta los renglones agregados y no escritos', () => {
    expect(unirDetallesDePago(['1234', '', '  ', '5678'])).toBe('1234\n5678');
    expect(unirDetallesDePago(['', ''])).toBe('');
  });

  it('para mostrar, en una línea con «·»', () => {
    expect(detallesParaMostrar('1234\n5678')).toBe('1234 · 5678');
    expect(detallesParaMostrar('882301')).toBe('882301');
    expect(detallesParaMostrar(null)).toBe('');
  });
});

describe('[GX.74] la regla se aplica a CADA renglón', () => {
  it('dos tarjetas de 4 dígitos pasan', () => {
    expect(detalleInvalido('tarjeta', '1234\n5678')).toBeNull();
  });

  it('⛔ una tarjeta COMPLETA en el segundo renglón NO pasa, y se dice cuál', () => {
    const r = detalleInvalido('tarjeta', '1234\n4152313800001234');
    expect(r).toContain('Renglón 2');
    expect(r).toContain('máximo 4');
  });

  it('⛔ letras en el tercer cheque no pasan', () => {
    expect(detalleInvalido('cheque', '1204\n1205\nAB-12')).toContain('Renglón 3');
  });

  it('con UN solo renglón el mensaje es el de siempre (sin «Renglón 1»)', () => {
    const r = detalleInvalido('tarjeta', '41523138');
    expect(r).not.toContain('Renglón');
    expect(r).toContain('máximo 4');
  });

  it(`⛔ más de ${MAX_DETALLES_PAGO} renglones no pasa`, () => {
    const muchos = Array.from({ length: MAX_DETALLES_PAGO + 1 }, (_, i) => String(1000 + i)).join('\n');
    expect(detalleInvalido('tarjeta', muchos)).toContain(`máximo ${MAX_DETALLES_PAGO} renglones`);
    const justos = Array.from({ length: MAX_DETALLES_PAGO }, (_, i) => String(1000 + i)).join('\n');
    expect(detalleInvalido('tarjeta', justos)).toBeNull();
  });
});

describe('[GX.74] la compuerta (la misma del 400 del servidor)', () => {
  const base = (detalle: string): EstadoAporte => ({
    forma_pago: 'transferencia', forma_pago_detalle: detalle,
    archivos: [{ role: 'comprobante_1', live: true }], exige_evidencia: true, concepto: 'Material',
  });

  it('dos referencias de transferencia: no falta nada', () => {
    expect(faltaParaMandar(base('882301\nTRSP-8823')).map((f) => f.id)).not.toContain('forma_pago_detalle');
  });

  it('⛔ sólo renglones vacíos cuenta como «falta el dato»', () => {
    expect(faltaParaMandar(base('\n  \n')).map((f) => f.id)).toContain('forma_pago_detalle');
  });
});
