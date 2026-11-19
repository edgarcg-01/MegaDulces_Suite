import { avisosFiscales, candidatosCfdi, cfdisDeFacturas, finDeMes, textoMetodo, type CfdiDelRenglon, type CfdiRecibido, type EntradaAvisoFiscal, type FacturaParaCfdi } from './cfdi-factura.contract';

const fac = (o: Partial<FacturaParaCfdi> = {}): FacturaParaCfdi => ({ item_id: 'I1', rfc: 'GAM010101AB1', importe: 11600, fecha: '2026-10-20', ...o });
const cfdi = (o: Partial<CfdiRecibido> = {}): CfdiRecibido => ({
  uuid: 'U1', emisor_rfc: 'GAM010101AB1', total: 11600, fecha: '2026-10-19', metodo_pago: 'PPD', forma_pago: '99', iva: 1600, ieps: 0, retenido: 0, ...o,
});
const de = (fs: FacturaParaCfdi[], cs: CfdiRecibido[], id = 'I1') => cfdisDeFacturas(fs, cs).get(id)!;

describe('[PGP.108] la factura del pago con su CFDI', () => {
  it('⭐ mismo RFC, total ±$1 y fecha ±45 días: ligado, con su PPD', () => {
    expect(de([fac()], [cfdi({ total: 11600.4 })])).toMatchObject({ estado: 'unico', candidatos: 1, metodo: 'PPD', cfdi: { uuid: 'U1' } });
    expect(de([fac()], [cfdi({ metodo_pago: 'pue' })]).metodo).toBe('PUE');
  });
  it('⛔ otro RFC, otro importe o fuera de la ventana: no casa', () => {
    expect(de([fac()], [cfdi({ emisor_rfc: 'OTR010101AB1' })]).estado).toBe('ninguno');
    expect(de([fac()], [cfdi({ total: 11637.13 })]).estado).toBe('ninguno');   // el control negativo medido
    expect(de([fac()], [cfdi({ fecha: '2026-08-30' })]).estado).toBe('ninguno');
  });
  it('⛔ dos CFDI posibles: no se elige solo', () => {
    expect(de([fac()], [cfdi(), cfdi({ uuid: 'U2', fecha: '2026-10-25' })])).toMatchObject({ estado: 'varios', cfdi: null, metodo: null });
  });
  it('⛔ uno a uno: un CFDI que es el único candidato de dos facturas no liga ninguna', () => {
    const r = cfdisDeFacturas([fac(), fac({ item_id: 'I2', fecha: '2026-10-22' })], [cfdi()]);
    expect(r.get('I1')!.estado).toBe('varios');
    expect(r.get('I2')!.estado).toBe('varios');
  });
  it('sin RFC o sin documento de Kepler se declara, no se adivina el método', () => {
    expect(de([fac({ rfc: null })], [cfdi()])).toMatchObject({ estado: 'sin_rfc', metodo: null });
    expect(de([fac({ importe: null, fecha: null })], [cfdi()]).estado).toBe('sin_documento');
  });
  it('un CFDI sin PUE/PPD se liga pero el método queda sin decir', () => {
    expect(de([fac()], [cfdi({ metodo_pago: null })])).toMatchObject({ estado: 'unico', metodo: null });
  });
  it('el RFC se compara sin importar mayúsculas ni espacios', () => {
    expect(candidatosCfdi(fac({ rfc: ' gam010101ab1 ' }), [cfdi()])).toHaveLength(1);
  });
  it('el texto del método dice qué implica', () => {
    expect(textoMetodo('PPD')).toBe('PPD · espera REP');
  });
});

describe('[PGP.158][PGP.163] el aviso fiscal del renglón del pago', () => {
  const cfdi = (o: Partial<CfdiRecibido> = {}): CfdiRecibido => ({ uuid: 'U1', emisor_rfc: 'GAM010101AB1', total: 11600, fecha: '2026-10-28', metodo_pago: 'PUE', forma_pago: '03', iva: 1600, ieps: null, retenido: null, ...o });
  const ligado = (c: CfdiRecibido): CfdiDelRenglon => ({ cfdi: { estado: 'unico', cfdi: c, candidatos: 1, metodo: c.metodo_pago === 'PPD' ? 'PPD' : 'PUE' }, cancelado_uuid: null });
  const e = (o: Partial<EntradaAvisoFiscal> = {}): EntradaAvisoFiscal => ({ renglon: ligado(cfdi()), fecha_pago: '2026-10-30', hoy: '2026-10-29', pagado: false, metodo_pago: 'transferencia', importe: 11600, ...o });
  const claves = (x: EntradaAvisoFiscal) => avisosFiscales(x).map((a) => a.clave);

  it('el límite de una PUE es el último día de su mes', () => {
    expect(finDeMes('2026-10-28')).toBe('2026-10-31');
    expect(finDeMes('2026-02-03')).toBe('2026-02-28');
    expect(finDeMes('2028-02-10')).toBe('2028-02-29');
    expect(finDeMes('2026-12-31')).toBe('2026-12-31');
  });

  it('PUE por transferencia programada dentro de su mes: sólo dice la fecha límite', () => {
    const a = avisosFiscales(e());
    expect(a).toEqual([{ clave: 'pue_limite', nivel: 'info', texto: 'PUE: pagar a más tardar el 31-oct' }]);
  });

  it('programada después de su mes: avisa con las dos fechas', () => {
    const a = avisosFiscales(e({ fecha_pago: '2026-11-03' }));
    expect(a[0]).toMatchObject({ clave: 'pue_fuera_de_mes', nivel: 'warn' });
    expect(a[0].texto).toBe('PUE: págala a más tardar el 31-oct (está para el 3-nov), o pide PPD');
  });

  it('su mes ya cerró y no se ha pagado: pedir la sustitución por PPD', () => {
    expect(claves(e({ hoy: '2026-11-02', fecha_pago: '2026-11-05' }))).toEqual(['pue_mes_cerrado']);
    expect(claves(e({ hoy: '2026-11-02', fecha_pago: '2026-10-30' }))).toEqual(['pue_mes_cerrado']); // pago atrasado
  });

  it('ya pagada: avisa sólo si salió fuera de su mes', () => {
    expect(claves(e({ pagado: true, hoy: '2026-11-19', fecha_pago: '2026-11-04' }))).toEqual(['pue_pagada_fuera']);
    expect(claves(e({ pagado: true, hoy: '2026-11-19', fecha_pago: '2026-10-30' }))).toEqual([]);
  });

  it('⛔ control: PUE cobrada con tarjeta o en efectivo, PPD, o sin CFDI ligado: nada de PUE', () => {
    expect(claves(e({ renglon: ligado(cfdi({ forma_pago: '04' })), fecha_pago: '2026-11-05' }))).toEqual([]);
    expect(claves(e({ renglon: ligado(cfdi({ forma_pago: '28' })), fecha_pago: '2026-11-05' }))).toEqual([]);
    expect(claves(e({ renglon: ligado(cfdi({ forma_pago: '01' })), fecha_pago: '2026-11-05' }))).toEqual([]);
    expect(claves(e({ renglon: ligado(cfdi({ metodo_pago: 'PPD', forma_pago: '99' })), fecha_pago: '2026-11-05' }))).toEqual([]);
    expect(claves(e({ renglon: { cfdi: { estado: 'ninguno', cfdi: null, candidatos: 0, metodo: null }, cancelado_uuid: null } }))).toEqual([]);
    expect(claves(e({ renglon: undefined }))).toEqual([]); // todavía no llegó: NO MEDIDO, no avisa
  });

  it('la factura cancelada en el SAT sin vigente: avisa antes que nada', () => {
    const r: CfdiDelRenglon = { cfdi: { estado: 'ninguno', cfdi: null, candidatos: 0, metodo: null }, cancelado_uuid: 'C1' };
    expect(claves(e({ renglon: r }))).toEqual(['cfdi_cancelado']);
    // con una vigente ligada, el cancelado viejo no importa (fue sustituida)
    expect(claves(e({ renglon: { ...ligado(cfdi({ metodo_pago: 'PPD', forma_pago: '99' })), cancelado_uuid: 'C1' } }))).toEqual([]);
  });

  it('efectivo arriba de $2,000 no es deducible; hasta $2,000 sí', () => {
    const ppd = ligado(cfdi({ metodo_pago: 'PPD', forma_pago: '99' }));
    expect(claves(e({ renglon: ppd, metodo_pago: 'efectivo', importe: 2000.01 }))).toEqual(['efectivo_no_deducible']);
    expect(claves(e({ renglon: ppd, metodo_pago: 'efectivo', importe: 2000 }))).toEqual([]);
    expect(claves(e({ renglon: ppd, metodo_pago: 'transferencia', importe: 50000 }))).toEqual([]);
  });
});
