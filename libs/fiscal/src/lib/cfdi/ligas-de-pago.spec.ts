import { cfdisUnicos, ligasParaInsertar, llaveDeLiga, type LlaveDeLiga } from './ligas-de-pago';

/**
 * `[PGP.110b]` La forma REAL que tumbó la descarga de recibidas del 27-oct: un REP que relaciona
 * varios documentos con `IdDocumento` en ceros, todos con parcialidad 1 (5 de 5 paquetes, medido
 * en prod el 2026-11-11), junto a documentos que sí son facturas. UUID de prueba, no reales.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const REP = 'AAAAAAAA-0000-4000-8000-000000000001';
const REP2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const CEROS = '00000000-0000-0000-0000-000000000000';
const F1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const F2 = 'BBBBBBBB-0000-4000-8000-000000000002';
const liga = (rep: string, docto: string | null, parc = 1, pagado = 100): LlaveDeLiga & { imp_pagado: number } =>
  ({ tenant_id: T, rep_uuid: rep, docto_uuid: docto, num_parcialidad: parc, imp_pagado: pagado });

/** Cuántas llaves aparecen más de una vez: lo que hace abortar al `INSERT … ON CONFLICT DO UPDATE`. */
const llavesRepetidas = (filas: readonly LlaveDeLiga[]) => filas.length - new Set(filas.map(llaveDeLiga)).size;

describe('[PGP.110b] ligas de REP que se pueden insertar juntas', () => {
  it('el REP del 27-oct: los documentos en ceros salen y las facturas reales quedan', () => {
    const lote = [liga(REP, CEROS, 1, 70658.41), liga(REP, F1, 1, 500), liga(REP, CEROS, 1, 134754.62), liga(REP, F2, 2, 300), liga(REP, CEROS, 1, 30696.46)];
    // Control: la entrada SÍ trae la llave repetida que rompía el INSERT (si no, la prueba no prueba nada).
    expect(llavesRepetidas(lote)).toBe(2);
    const r = ligasParaInsertar(lote);
    expect(llavesRepetidas(r.ligas)).toBe(0);
    expect(r.ligas.map((x) => x.docto_uuid)).toEqual([F1, F2]);
    expect(r).toMatchObject({ sinDocumento: 3, repetidas: 0 });
  });

  it('un documento sin IdDocumento tampoco se puede ligar (la columna es NOT NULL)', () => {
    const r = ligasParaInsertar([liga(REP, null), liga(REP, ''), liga(REP, F1)]);
    expect(r.ligas).toHaveLength(1);
    expect(r.sinDocumento).toBe(2);
  });

  it('la misma factura y parcialidad dos veces en un REP: queda la primera y se cuenta la otra', () => {
    const r = ligasParaInsertar([liga(REP, F1, 1, 10), liga(REP, F1, 1, 20), liga(REP, F1, 2, 30)]);
    expect(r.ligas.map((x) => [x.num_parcialidad, x.imp_pagado])).toEqual([[1, 10], [2, 30]]);
    expect(r.repetidas).toBe(1);
  });

  it('la misma factura pagada por DOS REP no es repetida: son dos ligas', () => {
    const r = ligasParaInsertar([liga(REP, F1), liga(REP2, F1)]);
    expect(r.ligas).toHaveLength(2);
    expect(r).toMatchObject({ sinDocumento: 0, repetidas: 0 });
  });
});

describe('[PGP.110b] CFDI únicos por lote', () => {
  it('el mismo comprobante dos veces en un ZIP queda una vez', () => {
    const r = cfdisUnicos([{ tenant_id: T, uuid: REP, xml: 'a' }, { tenant_id: T, uuid: F1, xml: 'b' }, { tenant_id: T, uuid: REP, xml: 'a2' }]);
    expect(r.cfdis.map((c) => [c.uuid, c.xml])).toEqual([[REP, 'a2'], [F1, 'b']]);
    expect(r.repetidos).toBe(1);
  });
});
