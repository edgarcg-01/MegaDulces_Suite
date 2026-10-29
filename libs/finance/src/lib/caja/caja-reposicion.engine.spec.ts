/**
 * `[CGA-A.61]` Reposición por sucursal — el motor, con los casos REALES del 27 y 28 de octubre de
 * 2026 (prod, sólo lectura). Cada propuesta lleva su negativa: un motor que propone sin frenos
 * siempre encuentra algo (CS.3.7 lo midió: 40 % de sus propuestas estaban a más de 7 días).
 */
import {
  armarReposicion, claseDelDocumento, leerReferenciaRetiro, sucursalesDeReposicion,
  type DocKepler, type EgresoLibro, type RetiroLibre, type VinculoLibro,
} from './caja-reposicion.engine';

const DEV = 'AST700-19758';
const ref = (suc: string, folio: string) => `${suc}|X-D-26|${folio}|0011`;
const doc = (suc: string, folio: string, fecha: string, monto: number, beneficiario = 'GASTOS GENERALES CAJA CHICA', captura = fecha): DocKepler => ({
  origen_ref: ref(suc, folio), sucursal: suc, doc_tipo: 'X-D-26', folio, fecha_valor: fecha, fecha_captura: captura, beneficiario, monto,
});
const egreso = (id: string, folio: string, origenRef: string, monto: number, fecha: string, origen: string | null): EgresoLibro => ({
  id, folio, origen_ref: origenRef, monto, fecha, origen_efectivo: origen,
});
const vinculo = (id: string, ledger: string, external: number, monto: number, r: string | null = null): VinculoLibro => ({
  link_id: id, cash_ledger_id: ledger, device: DEV, external_id: external, ref: r, monto,
});
const retiro = (external: number, occurredAt: string, r: string, total: number, libre: number, vinculadas: string[] = []): RetiroLibre => ({
  device: DEV, external_id: external, occurred_at: occurredAt, ref: r, total, libre, sucursales_vinculadas: vinculadas,
});
const base = { desde: '2026-10-22', hasta: '2026-10-28' };

describe('[CGA-A.61] lo que dice la referencia de un retiro (medidas en 45 días de CAOS)', () => {
  it.each([
    ['nom canindo', ['06'], 'nomina'],
    ['gastos canindo27 10 26', ['06'], 'gasto'],
    ['gstos canindo ', ['06'], 'gasto'],
    ['gnf 26/10', [], 'gasto'],
    ['gnf, nom y bonos morelia', ['07', '08'], null],
    ['nom more', ['07', '08'], 'nomina'],
    ['CUERITOS LUPITA YURE', ['04'], null],
    ['PAPAS JOAQIN 8E ', ['03'], null],
    ['ch finiquito 8esq', ['03'], null],
    ['ISAUL JACOB TENA MA', ['08'], null],
    ['ROMPOPE SAN AGUSTIN LPA', ['02'], null],
    ['gastos ph', ['01'], 'gasto'],
    ['nomina 40', [], 'nomina'],
    ['momina', [], 'nomina'],
    ['MARIO EDUARDO MELGOZA AMBRIZ CEDIS', ['00'], null],
    ['tdc amex', [], null],
  ])('«%s» → %j · %s', (r, sucursales, clase) => {
    expect(leerReferenciaRetiro(r)).toEqual({ sucursales, clase });
  });

  it('NEGATIVA: una palabra que CONTIENE una sigla no la nombra («cambio», «canales», «gas», «mercado pago»)', () => {
    for (const r of ['cambio', 'canales', 'carretas', 'gas noel', 'mercado pago', 'compra la tapatia']) {
      expect(leerReferenciaRetiro(r)).toEqual({ sucursales: [], clase: null });
    }
  });

  it('«abastos» solo es ambiguo (Morelia Abastos y La Piedad Abastos): nombra a las dos, no elige', () => {
    expect(leerReferenciaRetiro('gnf abastos').sucursales).toEqual(['02', '08']);
  });

  it('la clase del documento sale del beneficiario NOMINA, no del concepto', () => {
    expect(claseDelDocumento('NOMINA')).toBe('nomina');
    expect(claseDelDocumento('Nóminas')).toBe('nomina');
    expect(claseDelDocumento('GASTOS GENERALES CAJA CHIICA CANINDO')).toBe('gasto');
    expect(claseDelDocumento('ANOMINAL')).toBe('gasto');
    expect(claseDelDocumento(null)).toBe('gasto');
  });

  it('el universo son las sucursales con servidor Kepler, sin Oficinas', () => {
    expect(sucursalesDeReposicion()).toEqual(['01', '08', '07', '03', '02', '04', '06', '05']);
  });
});

describe('[CGA-A.61] CG-2026-00512: la nómina de Canindo va a «nom canindo», no al gnf de Morelia', () => {
  const docs = [doc('06', '0000344', '2026-10-28', 10511, 'NOMINA'), doc('05', '0000106', '2026-10-28', 3315, 'NOMINA')];
  const egresos = [
    egreso('l512', 'CG-2026-00512', ref('06', '0000344'), 10511, '2026-10-28', 'caos'),
    egreso('l513', 'CG-2026-00513', ref('05', '0000106'), 3315, '2026-10-28', 'caos'),
  ];
  const vinculos = [vinculo('k513', 'l513', 1777, 3310, 'nom canindo')];
  const gnf = retiro(1775, '2026-10-28T16:29:57Z', 'gnf 26/10', 156670, 4650, ['07', '08']);
  const nom = retiro(1777, '2026-10-28T16:48:48Z', 'nom canindo', 13820, 10510, ['05']);

  it('propone «nom canindo» por $10,510.00 y deja $1.00 al cajón', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [gnf, nom] });
    const g = r.grupos.find((x) => x.clave === '2026-10-28|06');
    expect(g?.estado).toBe('sin_vincular');
    expect(g?.propuesta?.asignaciones).toEqual([
      { ledger_id: 'l512', cg_folio: 'CG-2026-00512', origen_ref: ref('06', '0000344'), device: DEV, external_id: 1777, ref: 'nom canindo', monto: 10510 },
    ]);
    expect(g?.propuesta?.queda).toBe(1);
    expect(g?.propuesta?.razon).toContain('«nom canindo» nombra a Canindo y es de nómina, del 28/10 (libres $10,510.00)');
    expect(g?.propuesta?.razon).toContain('al peso: el retiro queda explicado entero');
    // Zamora Centro ya está explicada: $3,310 de CAOS y $5 del cajón.
    const z = r.grupos.find((x) => x.clave === '2026-10-28|05');
    expect(z).toMatchObject({ estado: 'explicada', caos: 3310, cajon: 5, propuesta: null });
  });

  it('NEGATIVA: el gnf de Morelia, con dinero de sobra, NO se propone para una nómina de Canindo', () => {
    const grande = { ...gnf, libre: 50000 };
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [grande] });
    expect(r.grupos.find((x) => x.clave === '2026-10-28|06')?.propuesta).toBeNull();
  });

  it('NEGATIVA: un retiro de GASTOS que nombra a Canindo no paga su NÓMINA', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [{ ...nom, ref: 'gastos canindo', libre: 20000 }] });
    expect(r.grupos.find((x) => x.clave === '2026-10-28|06')?.propuesta).toBeNull();
  });

  it('NEGATIVA: un «nom morelia» no se propone para Canindo aunque el monto sea exacto', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [{ ...nom, ref: 'nom morelia', libre: 10511 }] });
    expect(r.grupos.find((x) => x.clave === '2026-10-28|06')?.propuesta).toBeNull();
  });

  it('NEGATIVA: «nom canindo» de hace una semana es OTRA nómina (la referencia se repite cada semana)', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [{ ...nom, occurred_at: '2026-10-21T16:48:48Z' }] });
    expect(r.grupos.find((x) => x.clave === '2026-10-28|06')?.propuesta).toBeNull();
  });

  it('PLACEBO: un retiro sin sucursal ni historia, con el monto EXACTO, no se propone', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [retiro(1799, '2026-10-28T17:00:00Z', 'retiro', 10511, 10511)] });
    expect(r.grupos.find((x) => x.clave === '2026-10-28|06')?.propuesta).toBeNull();
  });
});

describe('[CGA-A.61] Canindo del 27/10: 10 egresos sin vincular ↔ 1732 + 1737 al peso', () => {
  const folios: Array<[string, string, number]> = [
    ['0000320', 'CG-2026-00465', 150], ['0000321', 'CG-2026-00468', 960], ['0000322', 'CG-2026-00466', 100],
    ['0000323', 'CG-2026-00467', 5500], ['0000324', 'CG-2026-00469', 300], ['0000325', 'CG-2026-00470', 100],
    ['0000328', 'CG-2026-00477', 150], ['0000329', 'CG-2026-00476', 3500], ['0000330', 'CG-2026-00478', 100],
  ];
  const docs = [...folios.map(([f, , m]) => doc('06', f, '2026-10-27', m)), doc('06', '0000331', '2026-10-27', 1250, 'ISAUL JACOB TENA')];
  const egresos = [
    ...folios.map(([f, cg, m]) => egreso(`l${cg.slice(-3)}`, cg, ref('06', f), m, '2026-10-27', null)),
    egreso('l490', 'CG-2026-00490', ref('06', '0000331'), 1250, '2026-10-27', 'caos'),
    // Kepler ya no tiene el 0000326 y el libro sí: CG-2026-00471.
    egreso('l471', 'CG-2026-00471', ref('06', '0000326'), 1080, '2026-10-27', null),
  ];
  const vinculos = [vinculo('k490', 'l490', 1758, 1250, 'ISAUL JACOB TENA CANINDO')];
  const retiros = [
    retiro(1732, '2026-10-27T17:02:57Z', 'gastos canindo27 10 26', 8190, 8190),
    retiro(1737, '2026-10-27T18:28:56Z', 'gstos canindo ', 3750, 3750),
  ];

  it('cada retiro se llena en orden de folio y ningún egreso queda partido', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos, retiros }).grupos.find((x) => x.clave === '2026-10-27|06');
    expect(g).toMatchObject({ estado: 'sin_vincular', n_sin_vincular: 10, sin_vincular: 11940, caos: 1250, total: 13190 });
    const por = (ext: number) => (g?.propuesta?.asignaciones ?? []).filter((a) => a.external_id === ext);
    expect(por(1732).map((a) => a.cg_folio)).toEqual([
      'CG-2026-00465', 'CG-2026-00468', 'CG-2026-00466', 'CG-2026-00467', 'CG-2026-00469', 'CG-2026-00470', 'CG-2026-00471',
    ]);
    expect(por(1732).reduce((a, x) => a + x.monto, 0)).toBe(8190);
    expect(por(1737).map((a) => a.cg_folio)).toEqual(['CG-2026-00477', 'CG-2026-00476', 'CG-2026-00478']);
    expect(por(1737).reduce((a, x) => a + x.monto, 0)).toBe(3750);
    expect(g?.propuesta).toMatchObject({ monto: 11940, queda: 0 });
    expect(g?.propuesta?.razon).toContain('al peso: los retiros quedan explicados enteros');
  });

  it('el egreso cuyo documento ya no está en Kepler se ve, marcado, no se esconde', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos, retiros }).grupos.find((x) => x.clave === '2026-10-27|06');
    expect(g?.docs.find((d) => d.cg_folio === 'CG-2026-00471')).toMatchObject({ en_kepler: false, folio: '0000326', estado: 'sin_vincular' });
  });

  it('NEGATIVA: un egreso que dice «del cajón» no se propone aunque haya retiro de su sucursal', () => {
    const delCajon = egresos.map((x) => (x.id === 'l465' ? { ...x, origen_efectivo: 'cajon' } : x));
    const g = armarReposicion({ ...base, docs, egresos: delCajon, vinculos, retiros }).grupos.find((x) => x.clave === '2026-10-27|06');
    expect(g?.propuesta?.asignaciones.some((a) => a.ledger_id === 'l465')).toBe(false);
    expect(g?.docs.find((d) => d.ledger_id === 'l465')).toMatchObject({ estado: 'cajon', falta: 0 });
  });
});

describe('⛔ [CGA-A.65] Morelia, 28/10: el gnf SÍ es de su hoja, y aun así el motor ya no propone', () => {
  const docs = [
    doc('07', '0000313', '2026-10-28', 4428, 'PAPAS JARYS', '2026-10-27'),
    doc('07', '0000315', '2026-10-28', 8865, 'BOTANAS PAU', '2026-10-27'),
    doc('07', '0000322', '2026-10-28', 5078, 'NOMINA'),
    // Un GASTO de Madero que dice «del cajón»: misma sucursal y misma clase que el gnf, y aun así
    // el barrido no lo toca (la mutación lo pidió: la nómina sola no probaba esta regla).
    doc('07', '0000319', '2026-10-28', 68, 'AUTOZONE DE MEXICO', '2026-10-27'),
    doc('08', '0000677', '2026-10-28', 9623.97),
    doc('08', '0000680', '2026-10-28', 15739, 'NOMINA'),
  ];
  const egresos = [
    egreso('l531', 'CG-2026-00531', ref('07', '0000313'), 4428, '2026-10-28', 'caos'),
    egreso('l532', 'CG-2026-00532', ref('07', '0000315'), 8865, '2026-10-28', 'caos'),
    egreso('l509', 'CG-2026-00509', ref('07', '0000322'), 5078, '2026-10-28', 'cajon'),
    egreso('l516', 'CG-2026-00516', ref('07', '0000319'), 68, '2026-10-28', 'cajon'),
    egreso('l528', 'CG-2026-00528', ref('08', '0000677'), 9623.97, '2026-10-28', 'caos'),
    egreso('l508', 'CG-2026-00508', ref('08', '0000680'), 15739, '2026-10-28', 'cajon'),
  ];
  const vinculos = [
    vinculo('k531', 'l531', 1775, 4420, 'gnf 26/10'), vinculo('k532', 'l532', 1775, 4290, 'gnf 26/10'),
    vinculo('k528', 'l528', 1775, 9620, 'gnf 26/10'),
  ];
  const gnf = retiro(1775, '2026-10-28T16:29:57Z', 'gnf 26/10', 156670, 4650, ['07', '08']);

  // Antes de [CGA-A.65] este caso proponía $4,575 a CG-2026-00532 y barría los centavos de Abastos
  // DESDE EL RENGLÓN DE MADERO: la hoja es de las dos, y el renglón no. Ahora lo resuelve una persona.
  it('ni propuesta ni barrido para Madero ni para Abastos; los dos dicen que se reponen por hoja', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos, retiros: [gnf] });
    const mm = r.grupos.find((x) => x.clave === '2026-10-28|07');
    expect(mm).toMatchObject({ estado: 'sin_vincular', sin_vincular: 4575, propuesta: null, por_hoja: true });
    expect(r.grupos.find((x) => x.clave === '2026-10-28|08')).toMatchObject({ estado: 'explicada', propuesta: null, por_hoja: true });
    // Ningún renglón se lleva un peso del gnf: ni el de Madero, ni el barrido desde otro.
    expect(r.grupos.flatMap((g) => g.propuesta?.asignaciones ?? [])).toEqual([]);
  });

  it('cuadre del grupo: total = por capturar + CAOS + cajón + sin vincular', () => {
    for (const g of armarReposicion({ ...base, docs, egresos, vinculos, retiros: [gnf] }).grupos) {
      expect(Math.round((g.por_capturar + g.caos + g.cajon + g.sin_vincular) * 100)).toBe(Math.round(g.total * 100));
    }
  });
});

// Se midió en Morelia (Abastos 23/10, «gnf ma» contra «gnf morelia»); desde [CGA-A.65] Morelia no
// recibe propuestas, y la regla se prueba con la otra referencia que nombra dos sucursales: «abastos».
describe('[CGA-A.61] la referencia más específica gana («gnf lpa» contra «gnf abastos», que nombra a dos)', () => {
  const docs = [doc('02', '0000600', '2026-10-23', 1050)];
  const egresos = [egreso('l418', 'CG-2026-00418', ref('02', '0000600'), 1050, '2026-10-23', null)];
  const abastos = retiro(1706, '2026-10-23T17:00:00Z', 'gnf abastos', 163080, 163080);
  const lpa = retiro(1707, '2026-10-23T17:05:00Z', 'gnf lpa', 58900, 58900);

  it('un gasto de La Piedad Abastos va a «gnf lpa» aunque «gnf abastos» sea anterior', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos: [], retiros: [abastos, lpa] }).grupos[0];
    expect(g.propuesta?.asignaciones.map((a) => a.external_id)).toEqual([1707]);
    expect(g.propuesta?.razon).toContain('(libres $58,900.00)');
  });

  it('sin el específico, el que nombra a las dos sigue sirviendo', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos: [], retiros: [abastos] }).grupos[0];
    expect(g.propuesta?.asignaciones.map((a) => a.external_id)).toEqual([1706]);
  });
});

describe('⛔ [CGA-A.65] Morelia se repone por hoja de zona: el motor no le propone ni le sugiere retiro', () => {
  // La hoja en papel de la venta del 23/10 (13 renglones, $58,953.69) se repuso con «gnf ma». El motor
  // por sucursal × día le daba a Madero «gnf morelia», que es el retiro de la hoja del 20.
  const docs = [
    doc('07', '0000282', '2026-10-23', 2850, 'CUERITOS PREMIUM ZACAPU'), doc('07', '0000283', '2026-10-23', 7313, 'BOTANAS PAU'),
    doc('08', '0000533', '2026-10-23', 13035, 'DELICIATE'), doc('08', '0000534', '2026-10-23', 7330, 'BOTANAS PAU'),
  ];
  const egresos = docs.map((d, i) => egreso(`l${i}`, `CG-2026-0039${i}`, d.origen_ref, d.monto, '2026-10-23', null));
  const morelia = retiro(1706, '2026-10-23T19:52:41Z', 'gnf morelia', 163080, 163080);
  const ma = retiro(1707, '2026-10-23T20:03:30Z', 'gnf ma', 58900, 58900);
  // La MISMA situación en Canindo: control de que la guarda es de Morelia y no un motor apagado.
  const comoCanindo = (d: DocKepler): DocKepler => ({ ...d, sucursal: '06', origen_ref: ref('06', d.folio) });

  it('Madero y Abastos del 23/10: sin propuesta y por hoja; ningún peso de los dos retiros se asigna', () => {
    const r = armarReposicion({ ...base, docs, egresos, vinculos: [], retiros: [morelia, ma] });
    for (const suc of ['07', '08']) {
      expect(r.grupos.find((g) => g.sucursal === suc)).toMatchObject({ estado: 'sin_vincular', propuesta: null, por_hoja: true });
    }
    expect(r.grupos.flatMap((g) => g.propuesta?.asignaciones ?? [])).toEqual([]);
  });

  it('CONTROL: lo mismo en Canindo, con un retiro que lo nombra, SÍ se propone y no es «por hoja»', () => {
    const ds = docs.map(comoCanindo);
    const eg = ds.map((d, i) => egreso(`l${i}`, `CG-2026-0039${i}`, d.origen_ref, d.monto, '2026-10-23', null));
    const g = armarReposicion({ ...base, docs: ds, egresos: eg, vinculos: [], retiros: [{ ...ma, ref: 'gnf canindo' }] }).grupos[0];
    expect(g).toMatchObject({ sucursal: '06', por_hoja: false });
    expect(g.propuesta?.monto).toBe(30528);
  });

  it('por capturar: «Reponer» no sugiere retiro para Morelia; para Canindo sí (control)', () => {
    const mor = armarReposicion({ ...base, docs, egresos: [], vinculos: [], retiros: [ma] });
    expect(mor.grupos.map((g) => [g.sucursal, g.estado, g.retiro_sugerido])).toEqual([['08', 'por_capturar', null], ['07', 'por_capturar', null]]);
    const can = armarReposicion({ ...base, docs: docs.map(comoCanindo), egresos: [], vinculos: [], retiros: [{ ...ma, ref: 'gnf canindo' }] });
    expect(can.grupos[0].retiro_sugerido?.external_id).toBe(1707);
  });

  it('el barrido de centavos de un retiro que paga a Canindo Y a Abastos no toca los de Abastos', () => {
    const ds = [doc('06', '0000400', '2026-10-28', 500), doc('08', '0000677', '2026-10-28', 9623.97)];
    const eg = [egreso('l400', 'CG-2026-00600', ref('06', '0000400'), 500, '2026-10-28', 'caos'),
      egreso('l528', 'CG-2026-00528', ref('08', '0000677'), 9623.97, '2026-10-28', 'caos')];
    const vs = [vinculo('k528', 'l528', 1790, 9620, 'gnf 26/10')];
    const sinNombre = retiro(1790, '2026-10-28T16:29:57Z', 'gnf 26/10', 20000, 1000, ['06', '08']);
    const g = armarReposicion({ ...base, docs: ds, egresos: eg, vinculos: vs, retiros: [sinNombre] }).grupos.find((x) => x.sucursal === '06');
    expect(g?.propuesta?.asignaciones.map((a) => [a.ledger_id, a.monto])).toEqual([['l400', 500]]);
  });
});

describe('[CGA-A.61] por capturar: «Reponer» sugiere el retiro y el universo se declara', () => {
  it('lo que sigue en la cola sugiere el retiro de su sucursal y nunca uno de otra', () => {
    const docs = [doc('06', '0000400', '2026-10-28', 175), doc('06', '0000401', '2026-10-28', 90)];
    const r = armarReposicion({
      ...base, docs, egresos: [], vinculos: [],
      retiros: [retiro(1801, '2026-10-28T17:00:00Z', 'gnf morelia', 9000, 9000), retiro(1802, '2026-10-28T17:05:00Z', 'gastos canindo', 270, 270)],
    });
    const g = r.grupos.find((x) => x.clave === '2026-10-28|06');
    expect(g).toMatchObject({ estado: 'por_capturar', n_por_capturar: 2, por_capturar: 265 });
    expect(g?.retiro_sugerido).toMatchObject({ external_id: 1802, ref: 'gastos canindo' });
  });

  it('sin ningún retiro claro no se sugiere nada (la persona elige)', () => {
    const r = armarReposicion({ ...base, docs: [doc('06', '0000400', '2026-10-28', 175)], egresos: [], vinculos: [], retiros: [retiro(1801, '2026-10-28T17:00:00Z', 'tdc amex', 9000, 9000)] });
    expect(r.grupos[0].retiro_sugerido).toBeNull();
  });

  it('Oficinas no se repone, y las sucursales sin un solo documento se nombran', () => {
    const r = armarReposicion({ ...base, docs: [doc('00', '0023637', '2026-10-27', 4000), doc('06', '0000400', '2026-10-28', 175)], egresos: [], vinculos: [], retiros: [] });
    expect(r.grupos.map((g) => g.sucursal)).toEqual(['06']);
    expect(r.universo.excluidas).toEqual(['00']);
    expect(r.universo.sin_documentos).toEqual(['01', '08', '07', '03', '02', '04', '05']);
  });
});

describe('[CGA-A.62] lo que no se aprobó antes no se propone ni se repone', () => {
  const aprob = (estado: 'sin_firma' | 'rechazado' | 'aprobado_despues' | 'aprobado_antes') => ({
    estado, texto: estado, solicitud_folio: '0000077', vale_id: 'v', vale_status: null, firmado_at: null, firma_exacta: false,
    bloquea: estado === 'sin_firma' || estado === 'rechazado', alerta: estado === 'aprobado_despues',
  });
  const docs = [doc('06', '0000344', '2026-10-28', 10511, 'NOMINA')];
  const egresos = [egreso('l512', 'CG-2026-00512', ref('06', '0000344'), 10511, '2026-10-28', 'caos')];
  const nom = retiro(1777, '2026-10-28T16:48:48Z', 'nom canindo', 13820, 10510, ['05']);

  it('⛔ un egreso cuyo vale espera firma NO entra a la propuesta, y el grupo lo cuenta', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos: [], retiros: [nom],
      aprobaciones: new Map([[ref('06', '0000344'), aprob('sin_firma')]]) }).grupos[0];
    expect(g.propuesta).toBeNull();
    expect(g.n_sin_aprobar).toBe(1);
    expect(g.docs[0].aprobacion?.estado).toBe('sin_firma');
  });

  it('⚠️ pagado antes de aprobarse: se propone (el dinero ya salió) pero se cuenta como alerta', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos: [], retiros: [nom],
      aprobaciones: new Map([[ref('06', '0000344'), aprob('aprobado_despues')]]) }).grupos[0];
    expect(g.propuesta?.asignaciones).toHaveLength(1);
    expect(g).toMatchObject({ n_sin_aprobar: 0, n_pagado_antes_de_aprobar: 1 });
  });

  it('⛔ lo que sigue en la cola y espera firma no recibe retiro sugerido para «Reponer»', () => {
    const pend = [doc('06', '0000400', '2026-10-28', 175), doc('06', '0000401', '2026-10-28', 90)];
    const gastos = retiro(1802, '2026-10-28T17:05:00Z', 'gastos canindo', 270, 270);
    const todo = armarReposicion({ ...base, docs: pend, egresos: [], vinculos: [], retiros: [gastos],
      aprobaciones: new Map([[ref('06', '0000400'), aprob('rechazado')], [ref('06', '0000401'), aprob('sin_firma')]]) }).grupos[0];
    expect(todo).toMatchObject({ estado: 'por_capturar', n_sin_aprobar: 2, retiro_sugerido: null });
    const uno = armarReposicion({ ...base, docs: pend, egresos: [], vinculos: [], retiros: [gastos],
      aprobaciones: new Map([[ref('06', '0000400'), aprob('rechazado')]]) }).grupos[0];
    expect(uno.retiro_sugerido?.external_id).toBe(1802);
  });

  // Medido en Madero el 28/10; desde [CGA-A.65] Morelia no recibe propuestas, y se prueba en Canindo.
  it('⛔ el barrido de centavos tampoco toca un egreso cuyo vale se rechazó', () => {
    const ds = [doc('06', '0000315', '2026-10-28', 8865, 'BOTANAS PAU', '2026-10-27'), doc('06', '0000313', '2026-10-28', 4428, 'PAPAS JARYS', '2026-10-27')];
    const eg = [egreso('l532', 'CG-2026-00532', ref('06', '0000315'), 8865, '2026-10-28', 'caos'), egreso('l531', 'CG-2026-00531', ref('06', '0000313'), 4428, '2026-10-28', 'caos')];
    const vs = [vinculo('k532', 'l532', 1775, 4290, 'gastos canindo 26/10'), vinculo('k531', 'l531', 1775, 4420, 'gastos canindo 26/10')];
    const gnf = retiro(1775, '2026-10-28T16:29:57Z', 'gastos canindo 26/10', 156670, 4650, ['06']);
    const g = armarReposicion({ ...base, docs: ds, egresos: eg, vinculos: vs, retiros: [gnf],
      aprobaciones: new Map([[ref('06', '0000313'), aprob('rechazado')]]) }).grupos[0];
    expect(g.propuesta?.asignaciones.map((x) => x.ledger_id)).toEqual(['l532']);
  });

  it('sin mapa de aprobaciones (no medido) nada se bloquea y el documento lo dice con null', () => {
    const g = armarReposicion({ ...base, docs, egresos, vinculos: [], retiros: [nom] }).grupos[0];
    expect(g.docs[0].aprobacion).toBeNull();
    expect(g.propuesta?.asignaciones).toHaveLength(1);
  });
});
