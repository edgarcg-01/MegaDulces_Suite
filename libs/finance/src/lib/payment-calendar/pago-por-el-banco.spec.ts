import { decidirPagosPorElBanco, VENTANA_BANCO_DIAS, type PagoPendiente, type SalidaBanco } from './pago-por-el-banco';

/**
 * `[PGP.121]` El banco dispara el pago. Formas tomadas de prod (2026-11-13): un pago planeado el 3-nov de
 * $452,754.08 que salió ese día de una sola cuenta («FERRERO DE MEXICO»), y los casos que no se adivinan.
 */
const HOY = '2026-11-13';
const p = (o: Partial<PagoPendiente> = {}): PagoPendiente => ({ id: 'p1', dia: '2026-11-03', importe: 452754.08, metodo: null, ...o });
const s = (o: Partial<SalidaBanco> = {}): SalidaBanco => ({ id: 'm1', cuenta_id: 'bbva', fecha: '2026-11-03', importe: 452754.08, ...o });

describe('[PGP.121] el banco dispara el pago', () => {
  it('una salida, una cuenta: probado, con la cuenta del movimiento (nadie la capturó)', () => {
    const d = decidirPagosPorElBanco([p()], [s(), s({ id: 'otra', importe: 100 })], HOY).get('p1');
    expect(d).toEqual({ estado: 'probado', movimiento_id: 'm1', cuenta_id: 'bbva', fecha: '2026-11-03', importe: 452754.08 });
  });

  it('tolera $1 y la ventana de días; fuera de eso no hay salida', () => {
    expect(decidirPagosPorElBanco([p()], [s({ importe: 452755.0 })], HOY).get('p1')?.estado).toBe('probado');
    expect(decidirPagosPorElBanco([p()], [s({ importe: 452755.2 })], HOY).get('p1')?.estado).toBe('sin_salida');
    expect(decidirPagosPorElBanco([p()], [s({ fecha: '2026-11-06' })], HOY).get('p1')?.estado).toBe('probado');
    expect(VENTANA_BANCO_DIAS).toBe(3);
    expect(decidirPagosPorElBanco([p()], [s({ fecha: '2026-11-07' })], HOY).get('p1')?.estado).toBe('sin_salida');
  });

  it('el mismo importe de dos cuentas: no se adivina', () => {
    expect(decidirPagosPorElBanco([p()], [s(), s({ id: 'm2', cuenta_id: 'banorte' })], HOY).get('p1')?.estado).toBe('varias_cuentas');
  });

  it('dos salidas iguales en la misma cuenta, o una salida para dos pagos: disputada', () => {
    expect(decidirPagosPorElBanco([p()], [s(), s({ id: 'm2', fecha: '2026-11-04' })], HOY).get('p1')?.estado).toBe('disputada');
    const dos = decidirPagosPorElBanco([p(), p({ id: 'p2', dia: '2026-11-04' })], [s()], HOY);
    expect(dos.get('p1')?.estado).toBe('disputada');
    expect(dos.get('p2')?.estado).toBe('disputada');
  });

  it('una salida que ya es prueba de otro pago no cuenta', () => {
    expect(decidirPagosPorElBanco([p()], [s()], HOY, new Set(['m1'])).get('p1')?.estado).toBe('sin_salida');
  });

  it('cheque y efectivo no los dispara el banco', () => {
    expect(decidirPagosPorElBanco([p({ metodo: 'cheque' })], [s()], HOY).get('p1')?.estado).toBe('excluido');
    expect(decidirPagosPorElBanco([p({ metodo: 'efectivo' })], [s()], HOY).get('p1')?.estado).toBe('excluido');
    expect(decidirPagosPorElBanco([p({ metodo: 'transferencia' })], [s()], HOY).get('p1')?.estado).toBe('probado');
  });

  it('un cheque excluido no le quita la salida a la transferencia del mismo importe', () => {
    const d = decidirPagosPorElBanco([p(), p({ id: 'ch', metodo: 'cheque' })], [s()], HOY);
    expect(d.get('p1')?.estado).toBe('probado');
  });

  it('un pago de un día que no ha llegado no se decide', () => {
    expect(decidirPagosPorElBanco([p({ dia: '2026-11-20' })], [s({ fecha: '2026-11-13' })], HOY).has('p1')).toBe(false);
  });
});
