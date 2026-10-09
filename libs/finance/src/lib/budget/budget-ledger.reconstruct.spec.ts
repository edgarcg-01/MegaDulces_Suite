/**
 * [PU.VG.4b] — Recomputar el estado de la partida desde su ledger.
 *
 * Unitaria de verdad: función pura, sin Postgres. El cruce contra datos reales lo hace
 * `database/tests/test-newdb-budget-ledger-cuadre.js` (read-only, corre contra prod).
 *
 * ⭐ El eje de esta suite no es «¿suma bien?» sino **«¿se NIEGA a dar un número cuando no puede
 * saberlo?»**. Un cuadre que inventa el bucket de una cancelación da verde sobre un ledger roto,
 * y eso es peor que no tener cuadre: convierte una auditoría en una coartada.
 */
import { reconstruirAcumuladores, diferencias } from './budget-ledger.reconstruct';

const m = (movement_type: string, amount: number, extra: Record<string, unknown> = {}) =>
  ({ movement_type, amount, ...extra });

describe('reconstruirAcumuladores · el camino feliz', () => {
  it('el ledger virgen de prod: sólo aperturas', () => {
    const r = reconstruirAcumuladores([m('apertura', 1000)]);
    expect(r.reconstruible).toBe(true);
    expect(r.vigente).toBe(1000);
    expect(r.reserved).toBe(0);
    expect(r.motivo).toBeNull();
  });

  it('el ciclo completo reserva → compromiso → ejercido → pago', () => {
    const r = reconstruirAcumuladores([
      m('apertura', 1000),
      m('reserva', 300),
      m('compromiso', 300, { from_reserva: true }),
      m('ejercido', 300),
      m('pago', 300),
    ]);
    expect(r.reconstruible).toBe(true);
    // la reserva se CONSUMIO al comprometer, no se sumo dos veces
    expect({ v: r.vigente, r: r.reserved, c: r.committed, e: r.exercised, p: r.paid })
      .toEqual({ v: 1000, r: 0, c: 0, e: 300, p: 300 });
  });

  it('⭐ compromiso SIN from_reserva consume disponible y NO baja la reserva', () => {
    const r = reconstruirAcumuladores([
      m('apertura', 1000), m('reserva', 300), m('compromiso', 200, { from_reserva: false }),
    ]);
    expect(r.reserved).toBe(300);
    expect(r.committed).toBe(200);
  });

  it('adecuaciones y transferencias mueven el vigente', () => {
    const r = reconstruirAcumuladores([
      m('apertura', 1000), m('ampliacion', 500), m('reduccion', 200),
      m('transferencia_in', 100), m('transferencia_out', 400),
    ]);
    expect(r.vigente).toBe(1000);
  });

  it('cancelación de reserva y de compromiso bajan buckets DISTINTOS', () => {
    const base = [m('apertura', 1000), m('reserva', 300), m('compromiso', 200, { from_reserva: false })];
    const cr = reconstruirAcumuladores([...base, m('cancelacion', 100, { cancel_target: 'reserva' })]);
    const cc = reconstruirAcumuladores([...base, m('cancelacion', 100, { cancel_target: 'compromiso' })]);
    expect({ r: cr.reserved, c: cr.committed }).toEqual({ r: 200, c: 200 });
    expect({ r: cc.reserved, c: cc.committed }).toEqual({ r: 300, c: 100 });
  });
});

describe('reconstruirAcumuladores · SE NIEGA cuando no puede saber [PRUEBA NEGATIVA]', () => {
  // ⛔ Estos son el corazón del candado. Si alguno devolviera `reconstruible: true`, el cuadre
  //    estaría dando verde sobre un ledger que no se puede reconstruir.
  it('cancelación SIN cancel_target: no inventa el bucket', () => {
    const r = reconstruirAcumuladores([m('apertura', 1000), m('reserva', 300), m('cancelacion', 100)]);
    expect(r.reconstruible).toBe(false);
    expect(r.motivo).toMatch(/cancel_target/);
  });

  it('cancelación con cancel_target basura tampoco pasa', () => {
    const r = reconstruirAcumuladores([m('cancelacion', 100, { cancel_target: 'otra_cosa' })]);
    expect(r.reconstruible).toBe(false);
  });

  it('compromiso SIN from_reserva: no adivina de dónde salió', () => {
    const r = reconstruirAcumuladores([m('apertura', 1000), m('compromiso', 200)]);
    expect(r.reconstruible).toBe(false);
    expect(r.motivo).toMatch(/from_reserva/);
  });

  it('⭐ `reversion` está en el CHECK de la tabla y NINGÚN código la produce: se declara, no se ignora', () => {
    const r = reconstruirAcumuladores([m('apertura', 1000), m('reversion', 50)]);
    expect(r.reconstruible).toBe(false);
    expect(r.motivo).toMatch(/no modelado/);
  });

  it('un monto no numérico no se trata como cero', () => {
    const r = reconstruirAcumuladores([m('apertura', Number.NaN)]);
    expect(r.reconstruible).toBe(false);
  });

  it('cuando NO es reconstruible, el motivo nunca viene en null', () => {
    for (const movs of [
      [m('cancelacion', 1)], [m('compromiso', 1)], [m('reversion', 1)],
    ]) {
      const r = reconstruirAcumuladores(movs);
      expect(r.reconstruible).toBe(false);
      expect(typeof r.motivo).toBe('string');
      expect(r.motivo).not.toBe('');
    }
  });
});

describe('diferencias · lo que el candado le reporta al humano', () => {
  it('sin diferencia, lista vacía', () => {
    const calc = reconstruirAcumuladores([m('apertura', 1000), m('reserva', 300)]);
    expect(diferencias({ vigente: 1000, reserved: 300, committed: 0, exercised: 0, paid: 0 }, calc)).toEqual([]);
  });

  it('un centavo YA es diferencia — el dinero no tiene tolerancia', () => {
    const calc = reconstruirAcumuladores([m('apertura', 1000)]);
    expect(diferencias({ vigente: 1000.01 }, calc)).toHaveLength(1);
  });

  it('⭐ detecta el caso que motiva el candado: un UPDATE directo que el ledger no explica', () => {
    // La partida dice que hay $5,000 reservados y el libro no tiene una sola reserva.
    const calc = reconstruirAcumuladores([m('apertura', 10000)]);
    const d = diferencias({ vigente: 10000, reserved: 5000 }, calc);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatch(/reserved/);
  });

  it('y el vigente inflado sin adecuación: mover dinero entre partidas sin movimiento', () => {
    const calc = reconstruirAcumuladores([m('apertura', 10000)]);
    expect(diferencias({ vigente: 14000 }, calc)[0]).toMatch(/vigente/);
  });
});
