import { textoValidacion, validadoParaKepler, validarPagos, type ComprobanteBanco, type EntradaValidacion, type MovimientoBanco, type PagoAValidar } from './validacion-pago.contract';

const pago = (o: Partial<PagoAValidar> = {}): PagoAValidar => ({ id: 'P1', dia: '2026-11-03', importe: 19400, cuenta_id: 'BB4166', metodo: 'transferencia', ...o });
const mov = (o: Partial<MovimientoBanco> = {}): MovimientoBanco => ({ id: 'M1', cuenta_id: 'BB4166', fecha: '2026-11-03', importe: 19400, ...o });
const comp = (o: Partial<ComprobanteBanco> = {}): ComprobanteBanco => ({ id: 'C1', cuenta_id: 'BB4166', fecha: '2026-11-03', importe: 19400, ...o });
const entrada = (o: Partial<EntradaValidacion> = {}): EntradaValidacion => ({
  pagos: [pago()], movimientos: [mov()], comprobantes: [comp()], cargado_hasta: new Map([['BB4166', '2026-11-09']]), ...o,
});
const v = (e: EntradaValidacion, id = 'P1') => validarPagos(e).get(id)!;

describe('[PGP.103] validar un pago contra el banco y su comprobante', () => {
  it('⭐ banco + comprobante: validado, con los dos ids, y se puede escribir en Kepler', () => {
    const r = v(entrada());
    expect(r).toMatchObject({ estado: 'validado', movimiento_id: 'M1', comprobante_id: 'C1', motivo: null, clabe: 'no_medido' });
    expect(validadoParaKepler(r)).toBe(true);
  });
  it('tolera centavos (±$1) y días (±5), no más', () => {
    expect(v(entrada({ movimientos: [mov({ importe: 19400.21, fecha: '2026-11-04' })], comprobantes: [comp({ importe: 19400.21, fecha: '2026-11-04' })] })).estado).toBe('validado');
    expect(v(entrada({ movimientos: [mov({ importe: 19402 })] })).estado).toBe('sin_movimiento');
    expect(v(entrada({ movimientos: [mov({ fecha: '2026-11-09' })] })).estado).toBe('sin_movimiento');
  });
  it('⛔ placebo: la misma salida 35 días después no valida', () => {
    expect(v(entrada({ movimientos: [mov({ fecha: '2026-12-08' })], cargado_hasta: new Map([['BB4166', '2026-12-31']]) })).estado).toBe('sin_movimiento');
  });
  it('⛔ otra cuenta no valida: sin la misma cuenta el ruido es de 4–7 %', () => {
    expect(v(entrada({ movimientos: [mov({ cuenta_id: 'SANT2169' })], cargado_hasta: new Map([['BB4166', '2026-11-09'], ['SANT2169', '2026-11-09']]) })).estado).toBe('sin_movimiento');
  });
  it('en el banco pero sin comprobante: falta el comprobante (no se escribe en Kepler)', () => {
    const r = v(entrada({ comprobantes: [] }));
    expect(r).toMatchObject({ estado: 'falta_comprobante', movimiento_id: 'M1', comprobante_id: null });
    expect(validadoParaKepler(r)).toBe(false);
  });
  it('un comprobante de otra cuenta o de otro importe no cuenta', () => {
    expect(v(entrada({ comprobantes: [comp({ cuenta_id: 'SANT2169' })] })).estado).toBe('falta_comprobante');
    expect(v(entrada({ comprobantes: [comp({ importe: 5000 })] })).estado).toBe('falta_comprobante');
    expect(v(entrada({ comprobantes: [comp({ cuenta_id: null })] })).estado).toBe('falta_comprobante');
  });
  it('⛔ uno a uno: dos pagos iguales que reclaman la misma salida se mandan a revisar', () => {
    const r = validarPagos(entrada({ pagos: [pago(), pago({ id: 'P2' })] }));
    expect(r.get('P1')!.estado).toBe('discrepa');
    expect(r.get('P2')!.estado).toBe('discrepa');
  });
  it('⛔ dos salidas posibles para un pago: no se elige sola', () => {
    expect(v(entrada({ movimientos: [mov(), mov({ id: 'M2', fecha: '2026-11-04' })] })).estado).toBe('discrepa');
  });
  it('⛔ un comprobante que casa con dos salidas no valida ninguna', () => {
    const e = entrada({
      pagos: [pago(), pago({ id: 'P2', dia: '2026-11-05' })],
      movimientos: [mov(), mov({ id: 'M2', fecha: '2026-11-05' })],
      comprobantes: [comp({ fecha: '2026-11-04' })],
    });
    // Cada pago tiene 2 candidatos (±5 días): discrepa por el movimiento, antes que por el comprobante.
    expect(validarPagos(e).get('P1')!.estado).toBe('discrepa');
    const e2 = entrada({ movimientos: [mov(), mov({ id: 'M9', fecha: '2026-11-07', cuenta_id: 'BB4166', importe: 19400 })], pagos: [pago({ dia: '2026-10-29' })] });
    expect(validarPagos(e2).get('P1')!.estado).toBe('discrepa');
  });
  it('dos comprobantes para la misma salida: deja uno', () => {
    expect(v(entrada({ comprobantes: [comp(), comp({ id: 'C2' })] })).estado).toBe('discrepa');
  });
  it('⛔ fecha imposible no valida', () => {
    expect(v(entrada({ movimientos: [mov({ fecha_invalida: true })] })).estado).toBe('sin_movimiento');
  });
  it('sin movimiento y con el estado de cuenta corto: esperando el banco, no «no apareció»', () => {
    const r = v(entrada({ movimientos: [], cargado_hasta: new Map([['BB4166', '2026-11-05']]) }));
    expect(r.estado).toBe('esperando_banco');
    expect(r.motivo).toContain('2026-11-05');
    expect(v(entrada({ movimientos: [], cargado_hasta: new Map() })).estado).toBe('esperando_banco');
  });
  it('sin cuenta de origen se declara, no se casa contra cualquier cuenta', () => {
    expect(v(entrada({ pagos: [pago({ cuenta_id: null })] })).estado).toBe('sin_cuenta');
  });
  it('efectivo se declara: la ventanilla hoy no deja rastro antes de Kepler', () => {
    expect(v(entrada({ pagos: [pago({ metodo: 'efectivo' })] })).estado).toBe('efectivo_no_medido');
  });
  it('cada estado tiene su frase', () => {
    expect(textoValidacion('falta_comprobante')).toBe('En el banco · falta el comprobante');
    expect(validadoParaKepler(null)).toBe(false);
  });
});
