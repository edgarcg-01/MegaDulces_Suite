import { polizaEgresoDelPago, textoPolizaEgreso, type FacturaParaPoliza, type RepDeFactura } from './momento-poliza.contract';

const fac = (o: Partial<FacturaParaPoliza> = {}): FacturaParaPoliza => ({ item_id: 'I1', cfdi_uuid: 'U-FAC', metodo: 'PPD', aplicado: 11600, ...o });
const rep = (o: Partial<RepDeFactura> = {}): RepDeFactura => ({ factura_uuid: 'U-FAC', rep_uuid: 'U-REP', pagado: 11600, fecha_pago: '2026-11-04', cancelado: false, ...o });
const DIA = '2026-11-03';

describe('[PGP.109] cuándo se genera la póliza de egreso (Contabilidad, 2026-11-10)', () => {
  it('⭐ PUE: lista al pagar, sin esperar nada', () => {
    expect(polizaEgresoDelPago([fac({ metodo: 'PUE' })], [], DIA, true)).toEqual({ estado: 'lista', facturas: [{ item_id: 'I1', estado: 'pue', rep_uuid: null }] });
  });
  it('⭐ PPD sin REP: espera el REP', () => {
    expect(polizaEgresoDelPago([fac()], [], DIA, true).estado).toBe('espera_rep');
  });
  it('⭐ PPD con su REP (mismo importe ±$1, fecha ±10 días): lista, con el REP asociado', () => {
    const p = polizaEgresoDelPago([fac()], [rep({ pagado: 11600.6 })], DIA, true);
    expect(p).toEqual({ estado: 'lista', facturas: [{ item_id: 'I1', estado: 'con_rep', rep_uuid: 'U-REP' }] });
  });
  it('⛔ un REP cancelado, de otro importe (otra parcialidad) o de otra fecha no cuenta', () => {
    expect(polizaEgresoDelPago([fac()], [rep({ cancelado: true })], DIA, true).estado).toBe('espera_rep');
    expect(polizaEgresoDelPago([fac()], [rep({ pagado: 5000 })], DIA, true).estado).toBe('espera_rep');
    expect(polizaEgresoDelPago([fac()], [rep({ fecha_pago: '2026-12-20' })], DIA, true).estado).toBe('espera_rep');
    expect(polizaEgresoDelPago([fac()], [rep({ factura_uuid: 'OTRA' })], DIA, true).estado).toBe('espera_rep');
  });
  it('⛔ sin poder medir los REP no se afirma «espera REP»: se declara (ADR-056)', () => {
    expect(polizaEgresoDelPago([fac()], [], DIA, false).estado).toBe('no_medido');
    // PUE no depende del REP: sigue lista aunque los REP no se midan.
    expect(polizaEgresoDelPago([fac({ metodo: 'PUE' })], [], DIA, false).estado).toBe('lista');
  });
  it('sin CFDI o sin método no se genera, y eso manda sobre esperar el REP', () => {
    expect(polizaEgresoDelPago([fac(), fac({ item_id: 'I2', cfdi_uuid: null })], [], DIA, true).estado).toBe('sin_cfdi');
    expect(polizaEgresoDelPago([fac({ metodo: null })], [], DIA, true).estado).toBe('sin_metodo');
    expect(polizaEgresoDelPago([], [], DIA, true).estado).toBe('sin_cfdi');
  });
  it('un pago con una PUE y una PPD sin REP espera el REP', () => {
    expect(polizaEgresoDelPago([fac({ metodo: 'PUE' }), fac({ item_id: 'I2' })], [], DIA, true).estado).toBe('espera_rep');
  });
  it('cada estado tiene su frase', () => {
    expect(textoPolizaEgreso('espera_rep')).toBe('Póliza en espera del REP del proveedor');
  });
});
