/**
 * `[CGA-A.35]` — Pruebas de «¿este documento de Kepler ya está en el libro nuevo?».
 *
 * Los casos salen de prod (2026-10-20). Las pruebas negativas importan más que las positivas:
 * un documento marcado «en el libro» desaparece de lo que hay que capturar, así que cada forma de
 * marcarlo por error es dinero que se vuelve invisible.
 */
import { casarLibroConKepler, cobroDeRutaComoKepler, indexaLibro, juntaCuadres, llaveKeplerDelLibro, marcaEnLibro, resumeEnLibro, type RenglonLibro } from './caja-kepler-libro.engine';
import { casarPorImporte } from './caja-cuadre.engine';

const libro = (p: Partial<RenglonLibro> & { folio: string }): RenglonLibro => ({
  estado: 'en_corte', origen_tipo: null, origen_ref: null, declared_doc_ref: null, ...p,
});

describe('indexaLibro / marcaEnLibro', () => {
  it('casa por origen_ref: el vínculo que puso el sistema al capturar', () => {
    const idx = indexaLibro([libro({ folio: 'CG-2026-00115', origen_tipo: 'pago_proveedor', origen_ref: '06|X-D-26|0000139|0011' })]);
    const [m] = marcaEnLibro([{ key: '06|X-D-26|0000139|0011', importe: 5470 }], idx);
    expect(m.en_libro).toEqual({ folio: 'CG-2026-00115', estado: 'en_corte', via: 'vinculo' });
  });

  it('casa por declared_doc_ref cuando el movimiento vino de CAOS (regla CGA-A.10)', () => {
    // Caso real: CG-2026-00018 se capturó desde CAOS y declaró el documento de Kepler.
    const idx = indexaLibro([libro({ folio: 'CG-2026-00018', estado: 'registrado', origen_tipo: 'caos', origen_ref: 'AST700-19758|1560', declared_doc_ref: '00|X-D-26|0023045|0011' })]);
    expect(marcaEnLibro([{ key: '00|X-D-26|0023045|0011', importe: 5000 }], idx)[0].en_libro?.via).toBe('declarado');
  });

  it('NEGATIVA: una declaración que NO viene de CAOS no salda nada', () => {
    // Caso real: CI-2026-00063 es un reintegro de nómina (ingreso, sin origen) que declara la
    // nómina PAGADA (gasto). Si contara, un gasto de Kepler se daría por capturado con un ingreso.
    const idx = indexaLibro([libro({ folio: 'CI-2026-00063', origen_tipo: null, declared_doc_ref: '06|X-D-26|0000161|0011' })]);
    expect(marcaEnLibro([{ key: '06|X-D-26|0000161|0011', importe: 10105 }], idx)[0].en_libro).toBeNull();
  });

  it('NEGATIVA: un renglón cancelado no salda nada', () => {
    const idx = indexaLibro([libro({ folio: 'CG-2026-00003', estado: 'cancelado', origen_tipo: 'pago_proveedor', origen_ref: '00|X-D-26|0000001|0011' })]);
    expect(marcaEnLibro([{ key: '00|X-D-26|0000001|0011', importe: 20 }], idx)[0].en_libro).toBeNull();
  });

  it('NEGATIVA: el mismo folio en OTRA unidad no salda (el folio es consecutivo por unidad)', () => {
    const idx = indexaLibro([libro({ folio: 'CI-2026-00064', origen_tipo: 'cobro', origen_ref: '06-003|U-A-5|0000007|0011' })]);
    expect(marcaEnLibro([{ key: '06-002|U-A-5|0000007|0011', importe: 23433.27 }], idx)[0].en_libro).toBeNull();
  });

  it('el vínculo gana sobre la declaración cuando los dos nombran el mismo documento', () => {
    const idx = indexaLibro([
      libro({ folio: 'CG-A', origen_tipo: 'caos', declared_doc_ref: '00|X-D-26|0000009|0011' }),
      libro({ folio: 'CG-B', origen_tipo: 'pago_proveedor', origen_ref: '00|X-D-26|0000009|0011' }),
    ]);
    expect(idx.get('00|X-D-26|0000009|0011')).toEqual({ folio: 'CG-B', estado: 'en_corte', via: 'vinculo' });
  });
});

describe('resumeEnLibro', () => {
  it('parte lo que ya está capturado de lo que de verdad falta, al centavo', () => {
    const r = resumeEnLibro([
      { importe: 5000, en_libro: { folio: 'CG-1', estado: 'en_corte', via: 'vinculo' } },
      { importe: 20076, en_libro: null },
      { importe: 19859.5, en_libro: null },
    ]);
    expect(r).toEqual({ en_libro_n: 1, en_libro_monto: 5000, pendiente_n: 2, pendiente_monto: 39935.5 });
  });

  it('sin «solo Kepler» publica ceros, no NaN', () => {
    expect(resumeEnLibro([])).toEqual({ en_libro_n: 0, en_libro_monto: 0, pendiente_n: 0, pendiente_monto: 0 });
  });
});

describe('cobroDeRutaComoKepler', () => {
  it('arma la llave del libro: almacen|U-A-5|folio|0011', () => {
    const k = cobroDeRutaComoKepler({ almacen: '01-003', cobro_folio: '0000009', fecha: '2026-10-12', importe: '17574.00', truck: 'ruta_23', concepto: 'Caja 1-100' });
    expect(`${k.sucursal}|${k.doc_tipo}|${k.folio}|${k.clave_banco}`).toBe('01-003|U-A-5|0000009|0011');
    expect(k.signo).toBe(1);
    expect(k.importe).toBe(17574);
    expect(k.beneficiario).toBe('CONTADO · ruta_23');
  });
});

describe('llaveKeplerDelLibro', () => {
  it('vínculo de Kepler para cobro/pago, declaración sólo si vino de CAOS, y null sin llave', () => {
    expect(llaveKeplerDelLibro({ origen_tipo: 'cobro', origen_ref: '01-003|U-A-5|0000009|0011', declared_doc_ref: null })).toBe('01-003|U-A-5|0000009|0011');
    expect(llaveKeplerDelLibro({ origen_tipo: 'caos', origen_ref: 'AST700-19758|1560', declared_doc_ref: '00|X-D-26|0023045|0011' })).toBe('00|X-D-26|0023045|0011');
    // NEGATIVA: el origen_ref de CAOS es un id de la MÁQUINA, no un documento de Kepler.
    expect(llaveKeplerDelLibro({ origen_tipo: 'caos', origen_ref: 'AST700-19758|1560', declared_doc_ref: null })).toBeNull();
    // NEGATIVA: el reintegro de nómina declara un gasto pero no vino de CAOS.
    expect(llaveKeplerDelLibro({ origen_tipo: null, origen_ref: null, declared_doc_ref: '06|X-D-26|0000161|0011' })).toBeNull();
  });
});

describe('casarLibroConKepler', () => {
  const mv = (key: string, importe: number, ref: string | null = null, fecha = '2026-10-14') => ({ key, importe, fecha, ref });

  it('casa por LLAVE aunque haya otro documento del mismo importe: identidad, no ambiguo', () => {
    const r = casarLibroConKepler(
      [mv('libro|CI-1', 15364, '01-002|U-A-5|0000010|0011')],
      [mv('01-002|U-A-5|0000010|0011', 15364), mv('01-006|U-A-5|0000010|0011', 15364)],
      5,
    );
    expect(r.pares[0].otro.key).toBe('01-002|U-A-5|0000010|0011');
    expect(r.pares[0]).toMatchObject({ identidad: true, ambiguo: false, candidatos: 1, delta: 0 });
    expect(r.otro_solos.map((x) => x.key)).toEqual(['01-006|U-A-5|0000010|0011']);
    expect(r.identidad_n).toBe(1);
  });

  it('NEGATIVA: un documento casado por llave no vuelve a casar por importe con otro movimiento', () => {
    const r = casarLibroConKepler(
      [mv('libro|CG-1', 2000, '00|X-D-26|0023030|0011'), mv('libro|CG-2', 2000)],
      [mv('00|X-D-26|0023030|0011', 2000)],
      5,
    );
    expect(r.casados_n).toBe(1);
    expect(r.caja_solos.map((x) => x.key)).toEqual(['libro|CG-2']);
  });

  it('lo que no trae llave se casa por importe y conserva su ambigüedad', () => {
    const r = casarLibroConKepler([mv('libro|CI-9', 1000)], [mv('A|U-A-5|1|0011', 1000), mv('B|U-A-5|1|0011', 1000)], 5);
    expect(r.pares[0].identidad).toBeUndefined();
    expect(r.pares[0].ambiguo).toBe(true);
    expect(r.ambiguos_n).toBe(1);
  });

  it('el documento de OTRO día también casa por llave, y no infla el total de Kepler del día', () => {
    const fuera = new Map([['00|X-D-26|0000139|0011', mv('00|X-D-26|0000139|0011', 252.6, null, '2026-10-14')]]);
    const r = casarLibroConKepler([mv('libro|CG-93', 252.6, '00|X-D-26|0000139|0011', '2026-10-15')], [], 5, fuera);
    expect(r.pares[0]).toMatchObject({ identidad: true });
    expect(r.otro_total).toBe(0);
    expect(r.caja_solos).toEqual([]);
  });

  it('NEGATIVA: una llave que no existe en ningún lado no inventa un par', () => {
    const r = casarLibroConKepler([mv('libro|CG-7', 500, '00|X-D-26|9999999|0011')], [], 5);
    expect(r.casados_n).toBe(0);
    expect(r.caja_solos).toHaveLength(1);
  });
});

describe('juntaCuadres', () => {
  it('suma los dos tramos sin perder pares ni huérfanos', () => {
    const a = casarPorImporte([{ key: '1|1', importe: 100, fecha: '2026-10-10' }], [{ key: 'K1', importe: 100, fecha: '2026-10-10' }], 5);
    const b = casarLibroConKepler([{ key: 'libro|CG-1', importe: 50, fecha: '2026-10-12', ref: 'K2' }], [{ key: 'K2', importe: 50, fecha: '2026-10-12', ref: null }], 5);
    const j = juntaCuadres(a, b);
    expect(j.casados_n).toBe(2);
    expect(j.caja_total).toBe(150);
    expect(j.identidad_n).toBe(1);
  });
});
