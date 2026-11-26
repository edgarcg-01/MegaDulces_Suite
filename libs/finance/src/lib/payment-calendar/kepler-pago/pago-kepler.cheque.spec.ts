import {
  MOTIVO_CHEQUE_SIN_COBRO, TIPO_CHEQUE, TIPO_TRANSFERENCIA, armarPagoKepler, motivosParaNoEscribir, referenciaDeCheque, tipoDelPago,
  type FacturaAPagar, type PagoKeplerEntrada, type PagoSuite,
} from './pago-kepler.armador';
import { plantillaPagoDe } from './kepler-pago-sink.adapter';

/**
 * `[PGP.171]` El cheque cobrado se escribe en Kepler como `X-D-25`. Formas medidas en prod el 2026-11-26 sobre los
 * `X-D-25` de Tesorería (el cheque 5377 de CEDIS, `0000863`): mismas ocho escrituras que el `X-D-26` y la misma póliza
 * E (cargo 201, abono 102); cambian el tipo (25), la forma (`c31 = 'Che'`), la referencia (`CHEQUE 5377`) y el
 * contador (`KFXD2501`). Vectores sintéticos (el repo es público).
 */
const factura = (o: Partial<FacturaAPagar> = {}): FacturaAPagar => ({
  almacen: '00', tipo: 20, subtipo: 1, folio: '0009469', concepto: 'C-001', referencia: '0-F9760',
  saldo: 1160, aplicado: 1160, iva: 160, ieps: 0, total: 1160, ...o,
});
const entrada = (o: Partial<PagoKeplerEntrada> = {}): PagoKeplerEntrada => ({
  sucursal: '00', fecha: '2026-11-18', hora: '00:00', referencia: referenciaDeCheque('5377'), importe: 1160,
  cuentaTesoreria: '4166', destino: 'BBVA · CLABE 012180001234567899',
  proveedor: { codigo: 'CA041', rfc: 'AAA010101AAA', nombre: 'PROVEEDOR DE PRUEBA', domicilio: ['CALLE 1', 'CIUDAD', ''], dias: 15 },
  facturas: [factura()], cheque: '5377', ...o,
});

describe('[PGP.171] el cheque en Kepler', () => {
  it('la referencia es la de Tesorería: «CHEQUE <número>», sin ceros a la izquierda', () => {
    expect(referenciaDeCheque('5377')).toBe('CHEQUE 5377');
    expect(referenciaDeCheque('05395')).toBe('CHEQUE 5395');
  });

  it('con número de cheque es un X-D-25; sin él, el X-D-26 de siempre (control)', () => {
    expect(tipoDelPago({ cheque: '5377' })).toBe(TIPO_CHEQUE);
    expect(tipoDelPago({ cheque: null })).toBe(TIPO_TRANSFERENCIA);
    expect(tipoDelPago({})).toBe(TIPO_TRANSFERENCIA);
  });

  it('arma el X-D-25: tipo 25 en el documento, sus aplicaciones y sus renglones; «Che»; sin banco destino', () => {
    const r = armarPagoKepler(entrada());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.tipo).toBe(25);
    expect(r.plan.kdm1).toMatchObject({ c31: 'Che', c11: 'CHEQUE 5377', c45: '4166', c16: 1160, c42: 1160, c17: 15, c85: '' });
    expect(r.plan.kdxe).toMatchObject({ c16: 'CHEQUE 5377', c22: '4166', c11: 1160, c20: 0 });
    expect(r.plan.kdxf.map((f) => f['c4'])).toEqual([25]);
    expect(r.plan.kdm5.map((f) => f['c4'])).toEqual([25]);
    // La póliza es la del X-D-26: cargo 201 por factura, abono 102 por el total.
    expect(r.plan.poliza.renglones.map((p) => [p['c3'], p['c4'], p['c5']])).toEqual([['201', 'C', 1160], ['102', 'A', 1160]]);
  });

  it('CONTROL: el mismo pago sin cheque sale como X-D-26 «Tra» con su banco destino', () => {
    const r = armarPagoKepler(entrada({ cheque: null, referencia: 'PG-0001' }));
    expect(r.ok && r.plan.tipo).toBe(26);
    expect(r.ok && r.plan.kdm1['c31']).toBe('Tra');
    expect(r.ok && r.plan.kdm1['c85']).toBe('012');
    expect(r.ok && r.plan.kdxf[0]['c4']).toBe(26);
  });

  it('NEGATIVA: un número de cheque que no es número no se escribe', () => {
    const r = armarPagoKepler(entrada({ cheque: '12' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join(' ')).toMatch(/número válido/);
    expect(armarPagoKepler(entrada({ cheque: 'abc' })).ok).toBe(false);
  });
});

describe('[PGP.171] cuándo se escribe un cheque', () => {
  const pago = (o: Partial<PagoSuite> = {}): PagoSuite => ({
    status: 'executed', payment_method: 'cheque', origen_kind: 'bank', kepler_payment_folio: null,
    lot_status: 'draft', items: [{ obligation_source: 'kepler_payable', branch_code: '00' }], validacion_estado: null,
    probado_por_el_banco: true, cheque_numero: '5377', ...o,
  });
  it('cobrado (el banco lo probó) y con su número: se escribe', () => {
    expect(motivosParaNoEscribir(pago())).toEqual([]);
  });
  it('NEGATIVA: sin cobro en el estado de cuenta, espera (DCH5: se escribe al cobro)', () => {
    expect(motivosParaNoEscribir(pago({ probado_por_el_banco: false }))).toContain(MOTIVO_CHEQUE_SIN_COBRO);
  });
  it('NEGATIVA: sin número en la referencia, no se sabe qué cheque es', () => {
    expect(motivosParaNoEscribir(pago({ cheque_numero: null })).join(' ')).toMatch(/número/);
  });
  it('NEGATIVA: el efectivo sigue sin escribirse; ya ligado, tampoco (duplicaría)', () => {
    expect(motivosParaNoEscribir(pago({ payment_method: 'efectivo' })).join(' ')).toMatch(/transferencias y cheques/);
    expect(motivosParaNoEscribir(pago({ kepler_payment_folio: '0000863' })).join(' ')).toMatch(/duplicaría/);
  });
});

describe('[PGP.171] la plantilla del cheque', () => {
  it('el cheque lee KEPLER_CHEQUE_TEMPLATE_FOLIO_NN; la transferencia, la suya (control)', () => {
    const env = { KEPLER_CHEQUE_TEMPLATE_FOLIO_00: '0000863', KEPLER_PAGO_TEMPLATE_FOLIO_00: '0023768' };
    expect(plantillaPagoDe('00', env, 25)).toEqual({ ok: true, valor: { serie: '1', folio: '0000863' } });
    expect(plantillaPagoDe('00', env, 26)).toEqual({ ok: true, valor: { serie: '1', folio: '0023768' } });
    expect(plantillaPagoDe('00', env)).toEqual({ ok: true, valor: { serie: '1', folio: '0023768' } });
  });
  it('NEGATIVA: sin plantilla de cheque en ese servidor, la escritura del cheque queda apagada', () => {
    const r = plantillaPagoDe('06', { KEPLER_PAGO_TEMPLATE_FOLIO_06: '0001234' }, 25);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/KEPLER_CHEQUE_TEMPLATE_FOLIO_06/);
  });
});
