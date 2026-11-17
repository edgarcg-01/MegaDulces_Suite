import type { CierreKeplerPago, PagoKeplerDelCierre } from '@megadulces/contracts';
import { decidirPagoEnKepler } from './pago-en-kepler';

/** `[PGP.132]` Lo que Kepler ya pagó se marca pagado en la Suite. Vectores SINTÉTICOS. */
const doc = (o: Partial<PagoKeplerDelCierre> = {}): PagoKeplerDelCierre => ({
  sucursal: '00', doc_prefix: 'XD2601', folio: '0024276', tipo: 'transferencia', fecha: '2026-11-12', aplicado: 1000,
  cuenta: '102', cuenta_nombre: 'BBVA 4176', comprobante_id: null, comprobante_estado: null, ...o,
});
const cierre = (o: Partial<CierreKeplerPago> = {}): CierreKeplerPago => ({
  estado: 'pagado', desfase_dias: 0, pagado: 1000,
  facturas: { pagada: 1, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 0, sin_medir: 0 }, pagos: [doc()], ...o,
});

describe('[PGP.132] decidirPagoEnKepler', () => {
  it('⭐ todas sus facturas pagadas con dinero: se da por pagado, ligado al pago de Kepler y con su método', () => {
    expect(decidirPagoEnKepler(cierre())).toEqual({ doc: doc(), metodo: 'transferencia' });
  });
  it('liga al pago con DINERO, no a la nota de crédito que también tocó la factura', () => {
    const nc = doc({ doc_prefix: 'XD5501', folio: 'NC1', tipo: 'nota_credito' });
    const ch = doc({ doc_prefix: 'XD2501', folio: 'CH9', tipo: 'cheque' });
    expect(decidirPagoEnKepler(cierre({ pagos: [nc, ch] }))).toEqual({ doc: ch, metodo: 'cheque' });
  });
  it('«pago por banco» de Kepler cuenta como transferencia; un anticipo, sin método', () => {
    expect(decidirPagoEnKepler(cierre({ pagos: [doc({ tipo: 'banco' })] }))?.metodo).toBe('transferencia');
    expect(decidirPagoEnKepler(cierre({ pagos: [doc({ tipo: 'anticipo' })] }))?.metodo).toBeNull();
  });
  it('⛔ pagado en parte o sin pagar: sigue pendiente', () => {
    expect(decidirPagoEnKepler(cierre({ estado: 'en_parte', facturas: { pagada: 1, saldada_sin_dinero: 0, en_parte: 1, sin_pagar: 0, sin_medir: 0 } }))).toBeNull();
    expect(decidirPagoEnKepler(cierre({ estado: 'sin_pagar', pagos: [], facturas: { pagada: 0, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 1, sin_medir: 0 } }))).toBeNull();
  });
  it('⛔ saldado SÓLO con notas o devoluciones: no salió dinero, no se da por pagado', () => {
    expect(decidirPagoEnKepler(cierre({ estado: 'saldado_sin_dinero', pagos: [doc({ tipo: 'devolucion' })],
      facturas: { pagada: 0, saldada_sin_dinero: 1, en_parte: 0, sin_pagar: 0, sin_medir: 0 } }))).toBeNull();
  });
  it('⛔ con alguna factura que Kepler no puede medir, no se adivina', () => {
    expect(decidirPagoEnKepler(cierre({ facturas: { pagada: 1, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 0, sin_medir: 1 } }))).toBeNull();
    expect(decidirPagoEnKepler(null)).toBeNull();
  });
});
