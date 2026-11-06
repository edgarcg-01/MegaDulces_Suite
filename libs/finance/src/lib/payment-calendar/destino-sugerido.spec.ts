import { destinosSugeridos, textoDeDestino } from './destino-sugerido';

/** `[PGP.75]` La CLABE que se propone sale de los comprobantes del propio proveedor, y sólo si es UNA. */
const A = '012180001234567899'; // dígito de control válido
const B = '002320094300416033'; // dígito de control válido (medida en prod: BANAMEX)
const MALA = '012180001234567891'; // el placeholder de la pantalla: control inválido

describe('[PGP.75] destinosSugeridos', () => {
  it('una sola CLABE en todos sus comprobantes: se propone, con cuántos y cuándo', () => {
    const r = destinosSugeridos([
      { proveedor_code: 'CA041', clabe: A, comprobantes: 3, ultima: '2026-09-01', banco: 'BBVA' },
      { proveedor_code: 'CA041 ', clabe: A, comprobantes: 2, ultima: '2026-10-05', banco: 'BBVA' },
    ]);
    expect(r.get('CA041')).toEqual({ clabe_estado: 'unica', clabe_sugerida: A, clabe_banco: 'BBVA', clabe_comprobantes: 5, clabe_ultima_vez: '2026-10-05', clabes_distintas: 1 });
  });
  it('⛔ dos CLABEs distintas: NO se propone ninguna, y se dice cuántas son', () => {
    const r = destinosSugeridos([
      { proveedor_code: 'CB001', clabe: A, comprobantes: 4, ultima: '2026-09-01', banco: 'BBVA' },
      { proveedor_code: 'CB001', clabe: B, comprobantes: 1, ultima: '2026-10-01', banco: 'BANAMEX' },
    ]);
    expect(r.get('CB001')).toMatchObject({ clabe_estado: 'varias', clabe_sugerida: null, clabes_distintas: 2, clabe_comprobantes: 5 });
  });
  it('⛔ una CLABE con el dígito de control mal leído por el OCR no cuenta', () => {
    const r = destinosSugeridos([
      { proveedor_code: 'CC002', clabe: MALA, comprobantes: 9, ultima: null, banco: null },
      { proveedor_code: 'CC002', clabe: B, comprobantes: 1, ultima: null, banco: 'BANAMEX' },
    ]);
    expect(r.get('CC002')).toMatchObject({ clabe_estado: 'unica', clabe_sugerida: B, clabe_comprobantes: 1 });
    expect(destinosSugeridos([{ proveedor_code: 'CD003', clabe: MALA, comprobantes: 1, ultima: null, banco: null }]).has('CD003')).toBe(false);
  });
});

describe('[PGP.75] textoDeDestino', () => {
  it('el mismo formato que teclea Tesorería', () => {
    expect(textoDeDestino({ clabe_sugerida: B, clabe_banco: 'BANAMEX' })).toBe(`BANAMEX · CLABE ${B}`);
    expect(textoDeDestino({ clabe_sugerida: B, clabe_banco: null })).toBe(`CLABE ${B}`);
    expect(textoDeDestino({ clabe_sugerida: null, clabe_banco: 'X' })).toBeNull();
  });
});
