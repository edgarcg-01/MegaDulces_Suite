import { armarMismaFactura, citaFactura, motivoDeKepler, type AjusteDeFactura, type EntradaDeFactura } from './misma-factura';

/**
 * `[RE.85]` La cadena de la factura GDL/319 de PAF en CEDIS, con importes SINTÉTICOS (el repo es público) y el
 * mismo patrón: la entrada 0010129 la registra completa, la devolución 0000209 descuenta la caja que faltó (y
 * otro producto devuelto), y la 0010302 vuelve a cargar esa caja, sin motivo escrito.
 */
const entradas: EntradaDeFactura[] = [
  { folio: '0010129', fecha: '2026-10-28', monto: 1000, concepto: 'FALTO 1 CJA DE SPORS 500G Y SE REGRESARA 16 CJS DE' },
  { folio: '0010302', fecha: '2026-11-11', monto: 20, concepto: '2% 10 DIAS' },
];
const devolucion: AjusteDeFactura = {
  tipo: '40', folio: '0000209', fecha: '2026-10-28', monto: 120, motivo: '2% 10 DIAS FALTO 1 CAJA DE CHOC SUPER SPORT',
  entrada_folio: '0010129',
  renglones: [
    { sku: '95324', nombre: 'CRISP KRINGLE 3 PACK', cantidad: 144, unidad: 'PAQ' },
    { sku: '05068', nombre: 'CHOC SUPER SPORT 500G PAF', cantidad: 28, unidad: 'PAQ' },
  ],
};
const caja = [{ sku: '05068', nombre: 'CHOC SUPER SPORT 500G PAF', cantidad: 28, unidad: 'PAQ' }];
const cfdi = { uuid: 'U-319', serie: 'GDL/2026/', folio: '319', total: 1000 };
const armar = (extra: Partial<Parameters<typeof armarMismaFactura>[0]> = {}) =>
  armarMismaFactura({ referencia: '0-F-319', folioEsta: '0010302', entradas, ajustes: [devolucion], renglones: { '0010302': caja }, cfdi, ...extra });

describe('[RE.85] la misma factura citada por varias entradas', () => {
  it('qué referencias nombran una factura', () => {
    expect(['0-F-319', 'F1389', '30-F1429', '0-f-12'].map(citaFactura)).toEqual([true, true, true, true]);
    expect(['0', '', null, '23/10/2026', 'RQ-2026-02588', 'COMISIONES'].map(citaFactura)).toEqual([false, false, false, false, false, false]);
  });

  it('el motivo de Kepler es lo que queda sin la condición de pago; la condición sola NO es motivo', () => {
    expect(motivoDeKepler('2% 10 DIAS FALTO 1 CAJA DE CHOC SUPER SPORT')).toBe('FALTO 1 CAJA DE CHOC SUPER SPORT');
    expect(motivoDeKepler('2% 10 DIAS')).toBeNull();
    expect(motivoDeKepler('3.5% 15 DÍAS')).toBeNull();
    expect(motivoDeKepler('FALTO 1 CJA DE SPORS 500G')).toBe('FALTO 1 CJA DE SPORS 500G');
    expect(motivoDeKepler(null)).toBeNull();
  });

  it('la cadena en orden, cada movimiento con su motivo, y lo que neta contra el CFDI', () => {
    const m = armar()!;
    expect(m.movimientos.map((x) => [x.tipo, x.folio, x.importe, x.motivo_origen])).toEqual([
      ['entrada', '0010129', 1000, 'kepler'],
      ['devolucion', '0000209', -120, 'kepler'],
      ['entrada', '0010302', 20, 'derivado'],
    ]);
    expect(m.movimientos[1]).toMatchObject({ motivo: 'FALTO 1 CAJA DE CHOC SUPER SPORT', aplicada_a: '0010129' });
    expect(m.movimientos[2]).toMatchObject({ es_esta: true,
      motivo: 'Llegó lo que se había descontado en la devolución 0000209: 28 PAQ CHOC SUPER SPORT 500G PAF' });
    expect(m.neto_kepler).toBe(900);
    expect(m.diferencia).toBe(-100); // lo devuelto que no volvió a entrar
  });

  it('NEGATIVA: si lo que entró no es exactamente lo descontado, no se inventa motivo: se DECLARA', () => {
    const otra = armar({ renglones: { '0010302': [{ ...caja[0], cantidad: 27 }] } })!;
    expect(otra.movimientos.find((x) => x.es_esta)).toMatchObject({ motivo: null, motivo_origen: 'sin_motivo' });
    const otraUnidad = armar({ renglones: { '0010302': [{ ...caja[0], unidad: 'CJA' }] } })!;
    expect(otraUnidad.movimientos.find((x) => x.es_esta)?.motivo_origen).toBe('sin_motivo');
  });

  it('NEGATIVA: una devolución POSTERIOR a la entrada no la explica', () => {
    const m = armar({ ajustes: [{ ...devolucion, fecha: '2026-11-20' }] })!;
    expect(m.movimientos.find((x) => x.es_esta)?.motivo_origen).toBe('sin_motivo');
  });

  it('el motivo deducido acompaña a la entrada aunque se vea la cadena DESDE otra (la 0010129)', () => {
    const m = armar({ folioEsta: '0010129' })!;
    expect(m.movimientos.find((x) => x.folio === '0010302')).toMatchObject({ es_esta: false, motivo_origen: 'derivado' });
    expect(m.movimientos.find((x) => x.folio === '0010129')).toMatchObject({ es_esta: true, motivo_origen: 'kepler' });
  });

  it('si sólo esta entrada cita la factura no hay cadena; sin CFDI ligado, la diferencia no se mide', () => {
    expect(armar({ entradas: [entradas[1]] })).toBeNull();
    expect(armar({ cfdi: null })!.diferencia).toBeNull();
  });

  it('una devolución sin motivo escrito también se declara', () => {
    const m = armar({ ajustes: [{ ...devolucion, motivo: '2% 10 DIAS' }] })!;
    expect(m.movimientos.find((x) => x.tipo === 'devolucion')).toMatchObject({ motivo: null, motivo_origen: 'sin_motivo' });
  });
});
