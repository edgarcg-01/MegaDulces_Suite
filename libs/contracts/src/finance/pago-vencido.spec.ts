/**
 * `[PGP.117]` La regla que libera a la semana un pago que nadie pagó.
 *
 * Vectores SINTÉTICOS (el repo es público): reproducen la FORMA de los casos medidos en prod el
 * 2026-11-12 —el pago sin abono en Kepler ni salida de banco, el que Kepler ya saldó, el que tiene
 * una factura a medias, el que salió del banco y Kepler no tiene, el que no viene de Kepler—.
 */
import { DIAS_PARA_LIBERAR, decidirVencido, diasEntre, notaLiberado, type PagoPendienteVencido } from './pago-vencido.contract';
import type { CierreKeplerPago, EstadoCierreKepler, EstadoFacturaCierre } from './cierre-kepler.contract';

const cierre = (estado: EstadoCierreKepler, f: Partial<Record<EstadoFacturaCierre, number>> = {}): CierreKeplerPago => ({
  estado, desfase_dias: null, pagado: 0, pagos: [],
  facturas: { pagada: 0, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 0, sin_medir: 0, ...f },
});

const p = (o: Partial<PagoPendienteVencido> = {}): PagoPendienteVencido => ({
  lotDate: '2026-11-03', cierre: cierre('sin_pagar', { sin_pagar: 2 }), salidaDeBanco: false, ligado: false, chequeEmitido: false, ...o,
});

describe('[PGP.117] decidirVencido', () => {
  it('[PGP.202] al día siguiente, sin abono en Kepler ni salida de banco (con el banco cubriendo): se libera', () => {
    expect(decidirVencido(p(), '2026-11-04')).toEqual({ accion: 'liberar', dias: 1 });
    expect(decidirVencido(p(), '2026-11-10')).toEqual({ accion: 'liberar', dias: 7 });
  });

  it('su mismo día se espera, aunque no haya ningún testigo (borde: 0 días)', () => {
    expect(decidirVencido(p(), '2026-11-03')).toEqual({ accion: 'esperar', dias: 0 });
    expect(DIAS_PARA_LIBERAR).toBe(1);
  });

  it('[PGP.202] al día siguiente con el banco todavía sin cubrir esos días: NO se libera (la espera la pone el banco)', () => {
    expect(decidirVencido(p({ salidaDeBanco: null }), '2026-11-04')).toEqual({ accion: 'conservar', dias: 1, motivo: 'banco_sin_medir' });
  });

  it('un día futuro también espera (no se libera lo que todavía no llega)', () => {
    expect(decidirVencido(p({ lotDate: '2026-11-20' }), '2026-11-12').accion).toBe('esperar');
  });

  it('Kepler ya lo saldó: se conserva (fue pagado, no se «quita»)', () => {
    expect(decidirVencido(p({ cierre: cierre('pagado', { pagada: 2 }) }), '2026-11-20')).toMatchObject({ accion: 'conservar', motivo: 'kepler_pagado' });
    expect(decidirVencido(p({ cierre: cierre('saldado_sin_dinero', { saldada_sin_dinero: 1 }) }), '2026-11-20')).toMatchObject({ motivo: 'kepler_pagado' });
  });

  it('una factura a medias en Kepler basta para conservar el pago entero', () => {
    expect(decidirVencido(p({ cierre: cierre('en_parte', { sin_pagar: 2, en_parte: 1 }) }), '2026-11-20')).toMatchObject({ accion: 'conservar', motivo: 'kepler_en_parte' });
  });

  it('una sola factura sin medir (no viene de Kepler) impide liberar, aunque las demás estén sin pagar', () => {
    expect(decidirVencido(p({ cierre: cierre('sin_pagar', { sin_pagar: 1, sin_medir: 1 }) }), '2026-11-20')).toMatchObject({ accion: 'conservar', motivo: 'kepler_sin_medir' });
    expect(decidirVencido(p({ cierre: cierre('sin_medir', { sin_medir: 2 }) }), '2026-11-20')).toMatchObject({ motivo: 'kepler_sin_medir' });
    expect(decidirVencido(p({ cierre: null }), '2026-11-20')).toMatchObject({ motivo: 'kepler_sin_medir' });
  });

  it('salió del banco el mismo importe y Kepler no lo tiene: se conserva (liberarlo invitaría a pagar dos veces)', () => {
    expect(decidirVencido(p({ salidaDeBanco: true }), '2026-11-20')).toMatchObject({ accion: 'conservar', motivo: 'banco' });
  });

  it('si el banco no se pudo leer, no se libera: fallar cerrado', () => {
    expect(decidirVencido(p({ salidaDeBanco: null }), '2026-11-20')).toMatchObject({ accion: 'conservar', motivo: 'banco_sin_medir' });
  });

  it('ligado a mano a un pago de Kepler o a un movimiento del banco: se conserva', () => {
    expect(decidirVencido(p({ ligado: true }), '2026-11-20')).toMatchObject({ accion: 'conservar', motivo: 'ligado' });
  });

  it('una fecha ilegible no libera nada', () => {
    expect(decidirVencido(p({ lotDate: 'sin-fecha' }), '2026-11-20').accion).toBe('esperar');
  });
});

/**
 * `[PGP.173]` El cheque entregado y sin depositar: Kepler no lo tiene (lo captura al cobro) y el banco no tiene
 * salida, así que para los dos testigos «nadie lo pagó». Es la forma del 5383 (liberado el 17-nov ya cobrado) y de los
 * cheques fechados a diciembre que ya están en manos del proveedor.
 */
describe('[PGP.173] un cheque emitido no se libera a la semana', () => {
  it('control: sin testigos, a la semana se libera — y el MISMO pago con cheque emitido se conserva', () => {
    expect(decidirVencido(p(), '2026-11-20')).toMatchObject({ accion: 'liberar' });
    expect(decidirVencido(p({ chequeEmitido: true }), '2026-11-20')).toEqual({ accion: 'conservar', dias: 17, motivo: 'cheque_emitido' });
  });

  it('no depende de cuánto tiempo pase: un mes después sigue conservado (sale cobrándose o cancelándose)', () => {
    expect(decidirVencido(p({ chequeEmitido: true }), '2026-12-15')).toMatchObject({ accion: 'conservar', motivo: 'cheque_emitido' });
  });

  it('gana a Kepler y al banco: los dos dirían «no se pagó» y es falso', () => {
    expect(decidirVencido(p({ chequeEmitido: true, cierre: cierre('sin_pagar', { sin_pagar: 3 }), salidaDeBanco: false }), '2026-11-20'))
      .toMatchObject({ motivo: 'cheque_emitido' });
  });

  it('el mismo día se espera igual que cualquier pago (no cambia el «esperar»)', () => {
    expect(decidirVencido(p({ chequeEmitido: true }), '2026-11-03')).toEqual({ accion: 'esperar', dias: 0 });
  });

  it('[PGP.202] al día siguiente ya NO espera: se conserva por ser cheque emitido (antes esperaba la semana)', () => {
    expect(decidirVencido(p({ chequeEmitido: true }), '2026-11-04')).toEqual({ accion: 'conservar', dias: 1, motivo: 'cheque_emitido' });
  });

  it('ligado a mano sigue contando como ligado (el motivo más fuerte primero)', () => {
    expect(decidirVencido(p({ chequeEmitido: true, ligado: true }), '2026-11-20')).toMatchObject({ motivo: 'ligado' });
  });
});

describe('[PGP.117] diasEntre y la nota', () => {
  it('cuenta días de calendario sin cruzar zona horaria (cambio de horario incluido)', () => {
    expect(diasEntre('2026-10-26', '2026-11-02')).toBe(7);
    expect(diasEntre('2026-11-03', '2026-11-03T23:59:00')).toBe(0);
  });
  it('la nota dice cuándo, cuántos días y que las facturas vuelven a estar disponibles', () => {
    const n = notaLiberado('2026-11-12', 9);
    expect(n).toContain('[liberado 2026-11-12]');
    expect(n).toContain('9 días');
    expect(n).toContain('disponibles');
  });
  it('[PGP.202] al día siguiente la nota dice «1 día», no «1 días»', () => {
    expect(notaLiberado('2026-11-04', 1)).toContain('] 1 día después de su día');
  });
});
