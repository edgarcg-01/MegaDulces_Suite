import { casarComprobantesConPagos, type ComprobanteBanco, type PagoPorComprobante } from './validacion-pago.contract';

const pago = (o: Partial<PagoPorComprobante> = {}): PagoPorComprobante => ({
  id: 'P1', dia: '2026-11-09', importe: 511359.31, cuenta_id: 'BBVA4176', metodo: 'transferencia', autorizado: true, con_comprobante: false, ...o,
});
const comp = (o: Partial<ComprobanteBanco> = {}): ComprobanteBanco => ({ id: 'C1', cuenta_id: 'BBVA4176', fecha: '2026-11-09', importe: 511359.31, ...o });
const casar = (cs: ComprobanteBanco[], ps: PagoPorComprobante[]) => casarComprobantesConPagos(cs, ps);

describe('[PGP.130] el comprobante dispara el pago (sin el banco)', () => {
  it('⭐ misma cuenta, mismo importe, mismo día: casa con su pago', () => {
    expect(casar([comp()], [pago()]).get('C1')).toEqual({ estado: 'casa', pago_id: 'P1', motivo: null });
  });
  it('tolera ±$1 y ±5 días, no más', () => {
    expect(casar([comp({ importe: 511360.2, fecha: '2026-11-14' })], [pago()]).get('C1')!.estado).toBe('casa');
    expect(casar([comp({ importe: 511361 })], [pago()]).get('C1')!.estado).toBe('sin_pago');
    expect(casar([comp({ fecha: '2026-11-15' })], [pago()]).get('C1')!.estado).toBe('sin_pago');
  });
  it('⛔ placebo: el mismo comprobante 35 días antes no casa con nada', () => {
    expect(casar([comp({ fecha: '2026-10-05' })], [pago()]).get('C1')!.estado).toBe('sin_pago');
  });
  it('⛔ otra cuenta de origen no casa, aunque importe y fecha sean iguales', () => {
    expect(casar([comp({ cuenta_id: 'SANT2169' })], [pago()]).get('C1')!.estado).toBe('sin_pago');
  });
  it('⛔ sin cuenta de origen leída no se casa contra cualquier cuenta', () => {
    const r = casar([comp({ cuenta_id: null })], [pago()]).get('C1')!;
    expect(r.estado).toBe('sin_lectura');
    expect(r.pago_id).toBeNull();
  });
  it('⛔ dos pagos posibles: no se adivina', () => {
    const r = casar([comp()], [pago(), pago({ id: 'P2', dia: '2026-11-10' })]).get('C1')!;
    expect(r).toMatchObject({ estado: 'varios', pago_id: null });
  });
  it('⛔ dos comprobantes para el mismo pago: ninguno casa', () => {
    const m = casar([comp(), comp({ id: 'C2' })], [pago()]);
    expect(m.get('C1')!.estado).toBe('disputado');
    expect(m.get('C2')!.estado).toBe('disputado');
  });
  it('⛔ un pago que ya tiene comprobante no recibe otro', () => {
    expect(casar([comp()], [pago({ con_comprobante: true })]).get('C1')).toMatchObject({ estado: 'ya_tiene', pago_id: 'P1' });
  });
  it('⛔ un pago sin autorizar no lo paga un comprobante (lo marca el banco, D6)', () => {
    expect(casar([comp()], [pago({ autorizado: false })]).get('C1')).toMatchObject({ estado: 'sin_autorizar', pago_id: 'P1' });
  });
  it('⛔ un pago con cheque o en efectivo no casa con un comprobante de transferencia', () => {
    expect(casar([comp()], [pago({ metodo: 'cheque' })]).get('C1')!.estado).toBe('sin_pago');
    expect(casar([comp()], [pago({ metodo: 'efectivo' })]).get('C1')!.estado).toBe('sin_pago');
  });
  it('un pago sin método preparado sí casa (el comprobante dice que fue transferencia)', () => {
    expect(casar([comp()], [pago({ metodo: null })]).get('C1')!.estado).toBe('casa');
  });
});
