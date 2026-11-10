import { candidatosCfdi, cfdisDeFacturas, textoMetodo, type CfdiRecibido, type FacturaParaCfdi } from './cfdi-factura.contract';

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
