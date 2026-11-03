import { alMedioPeso, planDePago, type DocumentoAPagar, type Respaldo, type ValeElegido } from './plan-de-pago';

/** `[LE.2.9]` Pagar en un solo acto: qué sale de la máquina, qué del cajón, y si firma Tesorería. */

const doc = (pesos: string, over: Partial<DocumentoAPagar> = {}): DocumentoAPagar => ({
  origenRef: '00|X-D-26|0023782|0011', folio: '0023782', beneficiario: 'NOMINA', cuentaKepler: '601-014',
  importeCentavos: BigInt(Math.round(Number(pesos) * 100)), ...over,
});
const aprobado = (c: bigint) => ({ folio: 'VA-1182', estado: 'aprobada', importeCentavos: c, aprobadoAt: '2026-11-02T15:00:00Z' });

describe('[LE.2.9] el plan de un pago', () => {
  it('el testigo de hoy: $796.73 se paga $796.50 — $780 de la máquina, $16.50 del cajón, −23 centavos declarados', () => {
    const d = doc('796.73');
    const p = planDePago(d, { yaOrdenado: false, vale: aprobado(d.importeCentavos) });
    expect(p).toMatchObject({ pagableCentavos: 79650n, maquinaCentavos: 78000n, cajonCentavos: 1650n, redondeoCentavos: -23n,
      requiereFirma: false, bloqueo: null });
  });

  it('el medio peso más cercano: 25 centavos sube, 24 baja; lo exacto no se toca', () => {
    expect(alMedioPeso(1025n)).toBe(1050n);
    expect(alMedioPeso(1024n)).toBe(1000n);
    expect(alMedioPeso(1075n)).toBe(1100n);
    expect(alMedioPeso(1050n)).toBe(1050n);
    for (let c = 0n; c < 1000n; c++) {
      const r = alMedioPeso(c) - c;
      expect(r >= -25n && r <= 25n).toBe(true);      // nunca más de 25 centavos
      expect(alMedioPeso(c) % 50n).toBe(0n);         // siempre pagable con monedas
    }
  });

  it('lo que es todo billete sale todo de la máquina; lo de menos de $20, todo del cajón', () => {
    expect(planDePago(doc('12480'), { yaOrdenado: false, vale: null })).toMatchObject({ maquinaCentavos: 1248000n, cajonCentavos: 0n });
    expect(planDePago(doc('15'), { yaOrdenado: false, vale: null })).toMatchObject({ maquinaCentavos: 0n, cajonCentavos: 1500n });
  });

  it('NEGATIVA: sin vale aprobado, firma Tesorería antes del dinero (V4, D18) — y dice por qué', () => {
    expect(planDePago(doc('500'), { yaOrdenado: false, vale: null })).toMatchObject({ requiereFirma: true, motivoFirma: 'no trae vale aprobado' });
    const d = doc('500');
    // `[LE.2.13]` PM 2026-11-03: «lo rechazado no se paga» — ni con la firma de Tesorería.
    expect(planDePago(d, { yaOrdenado: false, vale: { folio: 'VA-9', estado: 'rechazada', importeCentavos: d.importeCentavos, aprobadoAt: null } }))
      .toMatchObject({ bloqueo: 'vale_rechazado' });
    // `validada` sin quién lo aprobó: el cierre de Kepler valida vales que nadie firmó (GX.85).
    expect(planDePago(d, { yaOrdenado: false, vale: { folio: 'VA-7', estado: 'validada', importeCentavos: d.importeCentavos, aprobadoAt: null } }))
      .toMatchObject({ requiereFirma: true, motivoFirma: 'el vale VA-7 no guarda quién lo aprobó' });
  });

  it('NEGATIVA: no se paga dos veces, ni sin cuenta de Kepler, ni con un vale de otro importe, ni en cero', () => {
    expect(planDePago(doc('500'), { yaOrdenado: true, vale: null }).bloqueo).toBe('ya_ordenado');
    expect(planDePago(doc('500'), { yaOrdenado: false, yaPagado: true, vale: null }).bloqueo).toBe('ya_pagado');
    expect(planDePago(doc('500', { cuentaKepler: null }), { yaOrdenado: false, vale: null }).bloqueo).toBe('sin_cuenta_kepler');
    expect(planDePago(doc('500'), { yaOrdenado: false, vale: aprobado(40000n) }).bloqueo).toBe('vale_de_otro_importe');
    expect(planDePago(doc('0'), { yaOrdenado: false, vale: null }).bloqueo).toBe('importe_invalido');
  });

  it('las partes siempre suman lo pagable, y lo pagable es el importe más su redondeo declarado', () => {
    for (const pesos of ['796.73', '0.25', '19.99', '20.00', '1234.56', '9999.74']) {
      const d = doc(pesos);
      const p = planDePago(d, { yaOrdenado: false, vale: null });
      expect(p.maquinaCentavos + p.cajonCentavos).toBe(p.pagableCentavos);
      expect(d.importeCentavos + p.redondeoCentavos).toBe(p.pagableCentavos);
      expect(p.maquinaCentavos % 2000n).toBe(0n);
      expect(p.cajonCentavos < 2000n).toBe(true);
    }
  });
});

/**
 * `[LE.2.13]` Una sola autorización: la del gasto o la compra misma. Los casos salen de prod (2026-11-03):
 * un proveedor de mercancía (08/0000699) paga 3 entradas ($6,010 + $6,530 + $4,690), 08/0000707 paga 6 gastos, y el
 * testigo de nómina 00/0023782 tiene su gasto sin expediente en la Suite.
 */
describe('[LE.2.13] lo que respalda el pago decide si sale', () => {
  const firmado = (folio: string, c: bigint) => ({ folio, estado: 'validada', importeCentavos: c, aprobadoAt: '2026-11-02T15:36:54Z' });
  const sinPersona = (folio: string, c: bigint) => ({ folio, estado: 'validada', importeCentavos: c, aprobadoAt: null });
  const plan = (pesos: string, respaldo: Respaldo, vale: ValeElegido | null = null) =>
    planDePago(doc(pesos), { yaOrdenado: false, vale, respaldo });

  it('una compra con sus entradas cuadradas sale sin firma: la compra ya fue la autorización', () => {
    expect(plan('17230', { tipo: 'compra', aplicadoCentavos: 1723000n, documentos: 3, pagadosDeMas: 0 }))
      .toMatchObject({ requiereFirma: false, motivoFirma: null, bloqueo: null });
  });

  it('un gasto aprobado por una persona sale sin firma — también si son varios', () => {
    expect(plan('1100', { tipo: 'gasto', aplicadoCentavos: 110000n, gastos: [{ folio: '0000276', vale: firmado('0000308', 110000n) }] }))
      .toMatchObject({ requiereFirma: false, bloqueo: null });
    expect(plan('2300', { tipo: 'gasto', aplicadoCentavos: 230000n, gastos: [
      { folio: '0000244', vale: firmado('0000279', 150000n) }, { folio: '0000245', vale: firmado('0000278', 80000n) }] }))
      .toMatchObject({ requiereFirma: false, bloqueo: null });
  });

  it.each([
    ['el gasto sin expediente (el testigo de nómina)', { tipo: 'gasto', aplicadoCentavos: 79673n, gastos: [{ folio: '0009593', vale: null }] }, '796.73', 'gasto_sin_expediente'],
    ['validada sólo por el cierre de Kepler', { tipo: 'gasto', aplicadoCentavos: 60000n, gastos: [{ folio: '0000220', vale: sinPersona('0000247', 60000n) }] }, '600', 'gasto_sin_aprobar'],
    ['uno de varios sin aprobar', { tipo: 'gasto', aplicadoCentavos: 210000n, gastos: [
      { folio: '0000220', vale: sinPersona('0000247', 60000n) }, { folio: '0000244', vale: firmado('0000279', 150000n) }] }, '2100', 'gasto_sin_aprobar'],
    ['el gasto rechazado', { tipo: 'gasto', aplicadoCentavos: 52200n, gastos: [{ folio: '1', vale: { folio: '0009895', estado: 'rechazada', importeCentavos: 52200n, aprobadoAt: null } }] }, '522', 'vale_rechazado'],
    ['lo aplicado no suma el importe', { tipo: 'compra', aplicadoCentavos: 1000000n, documentos: 1, pagadosDeMas: 0 }, '17230', 'respaldo_no_cuadra'],
    ['una entrada que ya estaba pagada', { tipo: 'compra', aplicadoCentavos: 1723000n, documentos: 3, pagadosDeMas: 1 }, '17230', 'compra_pagada_de_mas'],
  ] as Array<[string, Respaldo, string, string]>)('NEGATIVA: %s no sale → %s', (_q, r, pesos, esperado) => {
    expect(plan(pesos, r).bloqueo).toBe(esperado);
  });

  it('sin respaldo en Kepler firma Tesorería; si la cajera eligió un vale aprobado, manda el vale (el ODS puede venir atrasado)', () => {
    expect(plan('500', { tipo: 'ninguno' })).toMatchObject({ requiereFirma: true, motivoFirma: 'Kepler no dice qué gasto o compra paga', bloqueo: null });
    expect(plan('500', { tipo: 'ninguno' }, aprobado(50000n))).toMatchObject({ requiereFirma: false, bloqueo: null });
  });

  it('el respaldo no se salta lo de siempre: lo ya pagado sigue sin pagarse dos veces', () => {
    expect(planDePago(doc('17230'), { yaOrdenado: false, yaPagado: true, vale: null,
      respaldo: { tipo: 'compra', aplicadoCentavos: 1723000n, documentos: 3, pagadosDeMas: 0 } }).bloqueo).toBe('ya_pagado');
  });
});
