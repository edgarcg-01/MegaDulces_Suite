import {
  cuadrar, estadoTrasCuadre, seguimientoDe,
  type CandidatoContpaqi, type ExportPendiente, type SeguimientoCuadre, type VeredictoCuadre,
} from './cuadre.engine';

/**
 * `[CP.8.99]` Candado de lo que la fila dice de una póliza entregada. Puro: sin base, sin Nest.
 *
 * ⭐ No se escriben a mano las filas de `poliza_exports`: cada caso pasa por el motor REAL (`cuadrar`), se guarda con la
 * misma regla que el servicio (`estadoTrasCuadre`) y recién ahí se traduce. Si el motor cambia lo que guarda, esto se
 * pone rojo en vez de seguir afirmando un mapa que ya no existe.
 * Cuentas, folios y montos de mentira (el repo es público).
 */
const HOY = '2001-03-20';
const P: ExportPendiente = {
  evento_tipo: 'bank_pago_proveedor', evento_id: 'pago|x', fecha: '2001-03-05', tipo_poliza: 2, total: 100,
  periodo: '2001-03', token: 'MD:aaaaaaaaaaaa', entregada_en: '2001-03-18',
};
const C = (extra: Partial<CandidatoContpaqi>): CandidatoContpaqi => ({
  ejercicio: 2001, periodo: 3, tipo_pol: '2', folio: '501', guid: null, fecha: '2001-03-05', concepto: 'OTRA COSA',
  cargos: 100, abonos: 100, ...extra,
});

/** Lo que queda en `poliza_exports` después de que el cuadre juzga, leído como lo lee el dictamen. */
function guardadoYLeido(p: ExportPendiente, cands: CandidatoContpaqi[]): { veredicto: VeredictoCuadre; fila: SeguimientoCuadre } {
  const r = cuadrar(p, cands, HOY);
  const fila = seguimientoDe({ estado: estadoTrasCuadre(r) ?? 'entregada', verificada: r.verificada, contpaqi_folio: r.contpaqi_folio });
  return { veredicto: r.veredicto, fila };
}

describe('[CP.8.99] la fila de una póliza entregada dice dónde está', () => {
  const casos: [string, ExportPendiente, CandidatoContpaqi[], VeredictoCuadre, SeguimientoCuadre][] = [
    ['casó por token y cuadra', P, [C({ concepto: `${P.token} PAGO` })], 'aplicada', 'en_contpaqi'],
    ['casó sólo por importe', P, [C({})], 'probable', 'por_confirmar'],
    ['nada todavía, en plazo', P, [], 'esperando', 'esperando'],
    ['casó por token con otro importe', P, [C({ concepto: `${P.token}`, cargos: 99 })], 'difiere', 'no_cuadra'],
    ['el token en dos pólizas', P, [C({ concepto: `${P.token}` }), C({ concepto: `${P.token}`, folio: '502' })], 'ambiguo', 'no_cuadra'],
    ['venció el plazo', { ...P, entregada_en: '2001-03-01' }, [], 'no_aparecio', 'no_aparecio'],
  ];
  it.each(casos)('%s', (_n, p, cands, veredicto, fila) => {
    const r = guardadoYLeido(p, cands);
    expect(r.veredicto, 'el caso ejerce el veredicto que dice').toBe(veredicto);
    expect(r.fila).toBe(fila);
  });

  it('⭐ los seis veredictos del motor caen en un estado; ninguno queda sin decir', () => {
    expect(new Set(casos.map((c) => c[3]))).toEqual(new Set<VeredictoCuadre>(['aplicada', 'probable', 'esperando', 'difiere', 'ambiguo', 'no_aparecio']));
  });

  it('`esperando` y `por_confirmar` se distinguen sólo por el folio: el folio 0 o "" no se confunde con ausente', () => {
    expect(seguimientoDe({ estado: 'entregada', verificada: null, contpaqi_folio: null })).toBe('esperando');
    expect(seguimientoDe({ estado: 'entregada', verificada: null, contpaqi_folio: 7 })).toBe('por_confirmar');
    expect(seguimientoDe({ estado: 'entregada', verificada: null, contpaqi_folio: '7' })).toBe('por_confirmar');
  });

  it('`aplicada` gana aunque `verificada` venga sin escribir (fila vieja)', () => {
    expect(seguimientoDe({ estado: 'aplicada', verificada: null, contpaqi_folio: null })).toBe('en_contpaqi');
  });
});
